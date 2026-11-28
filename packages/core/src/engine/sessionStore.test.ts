import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Logger, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { BlockId, TaskFailed } from "@runbooks/blocks-core/contract"
import { ContentHash, type RunbookDocument } from "../document/document.ts"
import { loadRunbook } from "../document/load.ts"
import { FileSystem } from "../services/FileSystem.ts"
import type { EventRow } from "../services/SessionDatabase.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { type TestCipherOptions, testCiphertext } from "../test-utils/TestSessionCipher.ts"
import {
  type MemorySessionDatabase,
  memorySessionDatabase,
} from "../test-utils/TestSessionDatabase.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { SessionId } from "./protocol.ts"
import {
  MAX_EXPIRED_PER_START,
  MAX_KEPT_SESSIONS,
  MAX_SAVED_LOG_CHARS,
  MAX_SAVED_LOG_LINES,
  MAX_SAVED_PAYLOAD_CHARS,
  MAX_SESSION_AGE_MILLIS,
  fileHashesOf,
  resumeOf,
  SAVED_SESSION_VERSION,
  SEQUENCE_RESERVE,
  type Saved,
  type SavedEvent,
  savedLogOf,
  type SavedSession,
  SessionStore,
} from "./sessionStore.ts"

const RUNBOOK = "/rb/runbook.mdx"
const sessionId = Schema.decodeSync(SessionId)
const blockId = Schema.decodeSync(BlockId)
const contentHash = Schema.decodeSync(ContentHash)
const hashOf = (digit: string) => contentHash(`sha256:${digit.repeat(64)}`)

/** A session id as the engine makes one, numbered. */
const idOf = (n: number) => sessionId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`)
const ID = idOf(1)

/** Runs `program` against a store over `database` on the test clock, and gives every warning it logged. */
const withStore = async <A>(
  program: Effect.Effect<A, never, SessionStore>,
  options: { readonly database?: MemorySessionDatabase; readonly cipher?: TestCipherOptions } = {},
) => {
  const warnings: string[] = []
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn")
      warnings.push(Array.isArray(message) ? message.join(" ") : String(message))
  })
  const result = await Effect.runPromise(
    program.pipe(
      Effect.provide(testSessionStore(options)),
      Effect.provide(Logger.layer([logger])),
      Effect.provide(TestClock.layer()),
    ),
  )
  return { result, warnings }
}

const keep = (createdAt = 0, firstSequence = 0) =>
  Effect.flatMap(SessionStore, (store) =>
    store.keep({ id: ID, runbook: RUNBOOK, runbookHash: hashOf("a"), createdAt, firstSequence }),
  )

const values = (named: Record<string, string | null>): Saved => ({
  kind: "values",
  payload: { values: named },
})

const DONE: Saved = {
  kind: "run",
  payload: {
    _tag: "Done",
    outcome: "warning",
    outputs: [{ key: "secretUrl", value: "https://out-SECRET", sensitive: true }],
    env: { DEPLOY_TOKEN: "env-SECRET" },
    repository: { path: "/work/repo", remoteUrl: null },
    log: { omitted: 3, lines: [{ stream: "stdout", text: "deployed" }] },
  },
}

const FAILED: Saved = {
  kind: "run",
  payload: {
    _tag: "Failed",
    error: new TaskFailed({ message: "exit 3", exitCode: 3 }),
    log: { omitted: 0, lines: [] },
  },
}

const LOGIN: Saved = {
  kind: "credential",
  payload: {
    provider: "cloud",
    source: "sso",
    targets: { account: { id: "111", name: "acct-111" }, role: null },
    values: { CLOUD_TOKEN: { value: "tok-SECRET", secret: true } },
  },
}

/** Whether `text` shows in any saved payload as it lies in the database. */
const inClear = (database: MemorySessionDatabase, text: string) =>
  database.events().some((row) => new TextDecoder("latin1").decode(row.payload).includes(text))

const row = (over: Partial<EventRow>): EventRow => ({
  session: ID,
  block: "form",
  kind: "values",
  version: SAVED_SESSION_VERSION,
  at: 0,
  runbookHash: hashOf("a"),
  fileHashes: {},
  payload: testCiphertext('{"values":{}}'),
  ...over,
})

describe("saving a session", () => {
  it("keeps each block's latest state of each kind, encrypted, with the hashes it was saved against", async () => {
    const database = memorySessionDatabase()
    const { result } = await withStore(
      Effect.gen(function* () {
        const saver = yield* keep(7)
        yield* saver.put(blockId("form"), values({ name: "vpc", token: "form-SECRET" }), {})
        yield* saver.put(blockId("deploy"), FAILED, { "deploy.sh": hashOf("b") })
        yield* saver.put(blockId("deploy"), DONE, { "deploy.sh": hashOf("c") })
        yield* saver.put(blockId("cloud"), LOGIN, {})
        yield* saver.put(blockId("form"), values({ name: "vpc-2", token: null }), {})
        return yield* (yield* SessionStore).latest(RUNBOOK)
      }),
      { database },
    )
    expect(
      database.events().map(({ block, kind, version, runbookHash, fileHashes }) => ({
        block,
        kind,
        version,
        runbookHash,
        fileHashes,
      })),
    ).toEqual([
      { block: "form", kind: "values", version: 1, runbookHash: hashOf("a"), fileHashes: {} },
      {
        block: "deploy",
        kind: "run",
        version: 1,
        runbookHash: hashOf("a"),
        fileHashes: { "deploy.sh": hashOf("c") },
      },
      { block: "cloud", kind: "credential", version: 1, runbookHash: hashOf("a"), fileHashes: {} },
    ])
    for (const secret of ["SECRET", "vpc", "deployed", "sso"])
      expect(inClear(database, secret)).toBe(false)
    expect(Option.map(result, ({ id, createdAt, events }) => ({ id, createdAt, events }))).toEqual(
      Option.some({
        id: ID,
        createdAt: 7,
        events: (
          [
            ["form", values({ name: "vpc-2", token: null })],
            ["deploy", DONE],
            ["cloud", LOGIN],
          ] as const
        ).map(([block, saved]): SavedEvent => ({
          block,
          kind: saved.kind,
          version: 1,
          runbookHash: hashOf("a"),
          fileHashes: block === "deploy" ? { "deploy.sh": hashOf("c") } : {},
          content: { _tag: "Read", saved },
        })),
      }),
    )
  })

  it("saves the session's row untrusted, used now and reserving its sequences, then its trust, and when and where it closed", async () => {
    const database = memorySessionDatabase()
    const { result } = await withStore(
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000)
        const saver = yield* keep(5, 7)
        const kept = database.sessions()
        yield* saver.trust(hashOf("d"))
        yield* TestClock.setTime(2_000)
        yield* saver.close(12)
        return { kept, latest: yield* (yield* SessionStore).latest(RUNBOOK) }
      }),
      { database },
    )
    expect(result.kept).toEqual([
      {
        id: ID,
        runbook: RUNBOOK,
        createdAt: 5,
        usedAt: 1_000,
        trusted: Option.none(),
        nextSequence: 7 + SEQUENCE_RESERVE,
      },
    ])
    expect(database.sessions()).toEqual([
      {
        id: ID,
        runbook: RUNBOOK,
        createdAt: 5,
        usedAt: 2_000,
        trusted: Option.some(hashOf("d")),
        nextSequence: 12,
      },
    ])
    expect(
      Option.map(result.latest, ({ usedAt, trusted, nextSequence }) => ({
        usedAt,
        trusted,
        nextSequence,
      })),
    ).toEqual(Option.some({ usedAt: 2_000, trusted: Option.some(hashOf("d")), nextSequence: 12 }))
  })

  it("saves no state where the system cannot encrypt, drops what it saved before, and keeps the row", async () => {
    const database = memorySessionDatabase()
    await withStore(
      Effect.flatMap(keep(), (saver) => saver.put(blockId("form"), values({ a: "1" }), {})),
      { database },
    )
    expect(database.events()).toHaveLength(1)
    const { warnings } = await withStore(
      Effect.gen(function* () {
        const saver = yield* keep()
        yield* saver.put(blockId("form"), values({ token: "form-SECRET" }), {})
        yield* saver.put(blockId("cloud"), LOGIN, {})
        yield* saver.trust(hashOf("d"))
      }),
      { database, cipher: { available: false } },
    )
    expect(database.events()).toEqual([])
    expect(database.sessions().map((session) => session.trusted)).toEqual([
      Option.some(hashOf("d")),
    ])
    expect(warnings).toEqual([
      "This system offers no encryption now, so sessions are saved without their values, runs or credentials.",
    ])
  })

  it(`does not save a state over ${MAX_SAVED_PAYLOAD_CHARS} characters, and drops the one it replaced`, async () => {
    const database = memorySessionDatabase()
    const { warnings } = await withStore(
      Effect.gen(function* () {
        const saver = yield* keep()
        yield* saver.put(blockId("form"), values({ a: "1" }), {})
        yield* saver.put(blockId("form"), values({ a: "x".repeat(MAX_SAVED_PAYLOAD_CHARS) }), {})
      }),
      { database },
    )
    expect(database.events()).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it("logs a database that refuses, and goes on as if nothing were saved", async () => {
    const database = memorySessionDatabase()
    for (const call of ["putSession", "putEvent", "deleteEvent", "latest"] as const)
      database.failing.add(call)
    const { result, warnings } = await withStore(
      Effect.gen(function* () {
        const saver = yield* keep()
        yield* saver.put(blockId("form"), values({ a: "1" }), {})
        yield* saver.drop(blockId("form"), "values")
        yield* saver.trust(hashOf("d"))
        yield* saver.close(1)
        return yield* (yield* SessionStore).latest(RUNBOOK)
      }),
      { database },
    )
    expect(result).toEqual(Option.none())
    expect(warnings).toHaveLength(6)
  })
})

describe("a run's saved log", () => {
  const out = (text: string) => ({ stream: "stdout" as const, text })

  it(`keeps the last ${MAX_SAVED_LOG_LINES} lines, and says how many came before`, () => {
    const lines = Array.from({ length: 600 }, (_, n) => out(`line ${n}`))
    const saved = savedLogOf(lines.slice(100), 700)
    expect(saved.omitted).toBe(700 - MAX_SAVED_LOG_LINES)
    expect(saved.lines).toEqual(lines.slice(-MAX_SAVED_LOG_LINES))
  })

  it(`keeps no more than ${MAX_SAVED_LOG_CHARS} characters, whole lines from the end`, () => {
    // Five lines as long as a log line may be, then one character.
    const wide = ["a", "b", "c", "d", "e"].map((c) => out(c.repeat(16_384)))
    const saved = savedLogOf([...wide, out("f")], 6)
    expect(saved).toEqual({ omitted: 2, lines: [...wide.slice(2), out("f")] })
  })
})

describe("reading a saved session", () => {
  it("reads a state a newer version saved as Newer without decrypting it, and one it cannot read as Unreadable", async () => {
    const database = memorySessionDatabase()
    await withStore(keep(), { database })
    const rows = [
      row({ block: "newer", version: SAVED_SESSION_VERSION + 1, payload: Uint8Array.of(1) }),
      row({ block: "otherKey", payload: testCiphertext('{"values":{}}', 2) }),
      row({ block: "notJson", payload: testCiphertext("{") }),
      row({ block: "notValues", payload: testCiphertext('{"values":[1]}') }),
      row({ block: "unknownKind", kind: "render" }),
      row({
        block: "tooLong",
        payload: testCiphertext(`{"values":{"a":"${"x".repeat(MAX_SAVED_PAYLOAD_CHARS)}"}}`),
      }),
      row({ block: "read", version: 0 }),
    ]
    for (const saved of rows) database.put(saved)
    const { result } = await withStore(
      Effect.flatMap(SessionStore, (store) => store.latest(RUNBOOK)),
      { database, cipher: { key: 1 } },
    )
    expect(
      Option.map(result, ({ events }) => events.map(({ block, content }) => [block, content._tag])),
    ).toEqual(
      Option.some([
        ["newer", "Newer"],
        ["otherKey", "Unreadable"],
        ["notJson", "Unreadable"],
        ["notValues", "Unreadable"],
        ["unknownKind", "Unreadable"],
        ["tooLong", "Unreadable"],
        ["read", "Read"],
      ]),
    )
  })

  it("finds no session for a row whose id the engine did not make", async () => {
    const database = memorySessionDatabase()
    const { result } = await withStore(
      Effect.gen(function* () {
        const store = yield* SessionStore
        yield* store.keep({
          id: sessionId("../../elsewhere"),
          runbook: RUNBOOK,
          runbookHash: hashOf("a"),
          createdAt: 0,
          firstSequence: 0,
        })
        return yield* store.latest(RUNBOOK)
      }),
      { database },
    )
    expect(result).toEqual(Option.none())
  })
})

describe("retention", () => {
  const DAY = 24 * 60 * 60 * 1000
  const NOW = 1_000 * DAY

  /** The sessions retention drops, with `used` sessions saved, each used at the time given. */
  const expiredAmong = async (used: ReadonlyArray<readonly [string, number]>) => {
    const database = memorySessionDatabase()
    const { result } = await withStore(
      Effect.gen(function* () {
        const store = yield* SessionStore
        for (const [id, usedAt] of used) {
          yield* TestClock.setTime(usedAt)
          yield* store.keep({
            id: sessionId(id),
            runbook: RUNBOOK,
            runbookHash: hashOf("a"),
            createdAt: 0,
            firstSequence: 0,
          })
        }
        yield* TestClock.setTime(NOW)
        return yield* store.expired
      }),
      { database },
    )
    return { expired: result, kept: database.sessions().map((session) => session.id) }
  }

  it(`names each session unused for ${MAX_SESSION_AGE_MILLIS / DAY} days, least recently used first`, async () => {
    const { expired, kept } = await expiredAmong([
      [idOf(1), NOW - 91 * DAY],
      [idOf(2), NOW - 89 * DAY],
      [idOf(3), NOW - 200 * DAY],
    ])
    expect(expired).toEqual([idOf(3), idOf(1)])
    expect(kept).toEqual([idOf(1), idOf(2), idOf(3)])
  })

  it(`names each session beyond the ${MAX_KEPT_SESSIONS} most recently used, at most ${MAX_EXPIRED_PER_START} at a start`, async () => {
    const recent = Array.from(
      { length: MAX_KEPT_SESSIONS + MAX_EXPIRED_PER_START + 1 },
      (_, n) => [idOf(n + 1), NOW - DAY + n] as const,
    )
    const { expired } = await expiredAmong(recent)
    expect(expired).toEqual(recent.slice(0, MAX_EXPIRED_PER_START).map(([id]) => id))
  })

  it("drops a row whose id the engine did not make, without naming it: it has no folders", async () => {
    const { expired, kept } = await expiredAmong([
      ["../../elsewhere", 0],
      [idOf(2), 0],
    ])
    expect(expired).toEqual([idOf(2)])
    expect(kept).toEqual([idOf(2)])
  })
})

// ---------------------------------------------------------------------------
// What a resumed session takes back
// ---------------------------------------------------------------------------

const RESUMED_RUNBOOK = [
  ['<Form id="form">', "```yaml", "- name: region", "  type: string", "```", "</Form>"].join("\n"),
  '<Run id="deploy" path="deploy.sh" />',
  '<Run id="check" command="true" />',
  '<CloudLogin id="cloud" />',
].join("\n\n")

const documentOf = async (runbook: string, script = "echo deploy") => {
  const parsed = await Effect.runPromise(
    Effect.gen(function* () {
      // A script is read only from inside the runbook's folder.
      yield* (yield* FileSystem).mkdir("/rb")
      return yield* loadRunbook(RUNBOOK, TOY_REGISTRY, { appVersion: "0.31.0" })
    }).pipe(Effect.provide(makeTestFileSystem({ [RUNBOOK]: runbook, "/rb/deploy.sh": script }))),
  )
  if (parsed._tag !== "Parsed") throw new Error(JSON.stringify(parsed.errors))
  return parsed.document
}

/** A state read back as saved by `version` for `document` as it is, `deploy`'s with its script's hash. */
const readEvent = (
  document: RunbookDocument,
  block: string,
  saved: Saved,
  version = SAVED_SESSION_VERSION,
): SavedEvent => ({
  block,
  kind: saved.kind,
  version,
  runbookHash: document.hash.runbook,
  fileHashes: block === "deploy" ? document.hash.files : {},
  content: { _tag: "Read", saved },
})

const savedSession = (
  events: ReadonlyArray<SavedEvent>,
  trusted: Option.Option<ContentHash> = Option.none(),
): SavedSession => ({ id: ID, createdAt: 0, usedAt: 86_400_000, trusted, nextSequence: 0, events })

const SUBMITTED: Saved = { kind: "run", payload: { _tag: "Submitted" } }

describe("resuming a saved session", () => {
  it("takes back values, runs, submits and credentials saved for the runbook as it is", async () => {
    const document = await documentOf(RESUMED_RUNBOOK)
    const resume = resumeOf(
      document,
      TOY_REGISTRY,
      savedSession(
        [
          readEvent(document, "form", values({ region: "eu" })),
          readEvent(document, "form", SUBMITTED),
          readEvent(document, "deploy", DONE),
          readEvent(document, "check", FAILED),
          readEvent(document, "cloud", LOGIN),
        ],
        Option.some(document.hash.combined),
      ),
    )
    expect(resume).toEqual({
      values: new Map([[blockId("form"), { values: { region: "eu" } }]]),
      runs: new Map([
        [blockId("form"), SUBMITTED.payload],
        [blockId("deploy"), DONE.payload],
        [blockId("check"), FAILED.payload],
      ]),
      credentials: new Map([[blockId("cloud"), LOGIN.payload]]),
      resumed: { lastUsed: DateTime.makeUnsafe(86_400_000), problems: [] },
    })
  })

  it("keeps an older version's values and credentials and drops its runs (open decision 6)", async () => {
    const document = await documentOf(RESUMED_RUNBOOK)
    const resume = resumeOf(
      document,
      TOY_REGISTRY,
      savedSession([
        readEvent(document, "form", values({ region: "eu" }), 0),
        readEvent(document, "form", SUBMITTED, 0),
        readEvent(document, "deploy", DONE, 0),
        readEvent(document, "cloud", LOGIN, 0),
      ]),
    )
    expect(resume.values).toEqual(new Map([[blockId("form"), { values: { region: "eu" } }]]))
    expect(resume.credentials).toEqual(new Map([[blockId("cloud"), LOGIN.payload]]))
    expect(resume.runs).toEqual(new Map())
    expect(resume.resumed.problems).toEqual([
      { _tag: "OlderVersion", version: 0, blocks: [blockId("form"), blockId("deploy")] },
    ])
  })

  it("drops each run saved for another runbook text or another script, keeping values, and says trust was lost", async () => {
    const before = await documentOf(RESUMED_RUNBOOK)
    const events = [
      readEvent(before, "form", values({ region: "eu" })),
      readEvent(before, "deploy", DONE),
      readEvent(before, "check", FAILED),
    ]
    const trusted = Option.some(before.hash.combined)

    const scriptChanged = await documentOf(RESUMED_RUNBOOK, "echo changed")
    const afterScript = resumeOf(scriptChanged, TOY_REGISTRY, savedSession(events, trusted))
    expect(Array.from(afterScript.runs.keys())).toEqual([blockId("check")])
    expect(afterScript.resumed.problems).toEqual([
      { _tag: "RunbookChanged", blocks: [blockId("deploy")] },
    ])

    const textChanged = await documentOf(`${RESUMED_RUNBOOK}\n\nA new line.`)
    const afterText = resumeOf(textChanged, TOY_REGISTRY, savedSession(events, trusted))
    expect(afterText.runs).toEqual(new Map())
    expect(afterText.values).toEqual(new Map([[blockId("form"), { values: { region: "eu" } }]]))
    expect(afterText.resumed.problems).toEqual([
      { _tag: "RunbookChanged", blocks: [blockId("deploy"), blockId("check")] },
    ])

    const untouched = resumeOf(
      textChanged,
      TOY_REGISTRY,
      savedSession([readEvent(textChanged, "form", values({}))], trusted),
    )
    expect(untouched.resumed.problems).toEqual([{ _tag: "RunbookChanged", blocks: [] }])
  })

  it("takes back the run of the first of two blocks with one id, by its own files", async () => {
    // The second is misconfigured (duplicateId) and names no file; the id is the first's.
    const document = await documentOf(
      `${RESUMED_RUNBOOK}\n\n<Run id="deploy" command="echo again" />`,
    )
    expect(fileHashesOf(document, TOY_REGISTRY).get(blockId("deploy"))).toEqual(document.hash.files)
    const resume = resumeOf(
      document,
      TOY_REGISTRY,
      savedSession([readEvent(document, "deploy", DONE)], Option.some(document.hash.combined)),
    )
    expect(resume.runs).toEqual(new Map([[blockId("deploy"), DONE.payload]]))
  })

  it("takes nothing a newer version saved, nothing it cannot read, and nothing for a block the runbook lacks", async () => {
    const document = await documentOf(RESUMED_RUNBOOK)
    const resume = resumeOf(
      document,
      TOY_REGISTRY,
      savedSession([
        { ...readEvent(document, "form", values({})), version: 3, content: { _tag: "Newer" } },
        { ...readEvent(document, "deploy", DONE), version: 2, content: { _tag: "Newer" } },
        { ...readEvent(document, "cloud", LOGIN), version: 2, content: { _tag: "Newer" } },
        { ...readEvent(document, "check", FAILED), content: { _tag: "Unreadable" } },
        readEvent(document, "gone", values({ region: "eu" })),
      ]),
    )
    expect([resume.values.size, resume.runs.size, resume.credentials.size]).toEqual([0, 0, 0])
    expect(resume.resumed.problems).toEqual([
      { _tag: "NewerVersion", version: 2, blocks: [blockId("deploy"), blockId("cloud")] },
      { _tag: "NewerVersion", version: 3, blocks: [blockId("form")] },
      { _tag: "Unreadable", blocks: [blockId("check")] },
    ])
  })
})
