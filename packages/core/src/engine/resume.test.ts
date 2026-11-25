/**
 * Closing the app and opening the same runbook again: each test starts the
 * engine more than once on one machine, whose files and sessions database
 * outlive each start, as the app's do.
 */
import { describe, expect, it } from "bun:test"
import { Duration, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  BlockId,
  defineTask,
  TaskCancelled,
  type TaskError,
  type TaskEvent,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import type { FieldValue } from "@runbooks/blocks-core/form"
import type { CredentialAction, CredentialStateTag } from "../credential/lifecycle.ts"
import type {
  CredentialEnv,
  Identity,
  ProviderInfo,
  ResolvedSource,
} from "../credential/provider.ts"
import { FileWriteError } from "../errors/index.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { SessionDatabase, type SessionRow } from "../services/SessionDatabase.ts"
import {
  type ProviderCall,
  type ScriptedProvider,
  testCredentialProviders,
} from "../test-utils/TestCredentialProviders.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { type TestCipherOptions, testCiphertext } from "../test-utils/TestSessionCipher.ts"
import {
  type MemorySessionDatabase,
  memorySessionDatabase,
} from "../test-utils/TestSessionDatabase.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import { Caller, type EventEnvelope } from "./protocol.ts"
import {
  MAX_SAVED_LOG_CHARS,
  MAX_SAVED_LOG_LINES,
  MAX_SESSION_AGE_MILLIS,
  SAVED_SESSION_VERSION,
} from "./sessionStore.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

const line = (text: string): TaskEvent<string> => ({ _tag: "Log", stream: "stdout", line: text })

/** What each `<Run command>` does. */
const SCRIPTS: Readonly<Record<string, Stream.Stream<TaskEvent<string>, TaskError>>> = {
  deploy: Stream.make(
    line("deploying"),
    { _tag: "Output", key: "url", value: "https://app" },
    { _tag: "Output", key: "secretToken", value: "tok-SECRET" },
  ),
  noisy: Stream.fromIterable(Array.from({ length: 600 }, (_, n) => line(`line ${n}`))),
  wide: Stream.fromIterable(["a", "b", "c"].map((c) => line(c.repeat(40_000)))),
  hang: Stream.never,
}

/** The toy registry, `<Run>` running `SCRIPTS`. An output whose key starts with `secret` is sensitive. */
const REGISTRY = {
  ...TOY_REGISTRY,
  Run: defineTask({
    ...TOY_REGISTRY.Run,
    outputs: (p) =>
      Object.fromEntries(
        (p.outputs ?? []).map((key) => [key, { sensitive: key.startsWith("secret") }]),
      ),
    run: (p) => SCRIPTS[p.command ?? ""] ?? Stream.empty,
  }),
}

const FORM =
  '<Form id="form" variables={[{ name: "region", type: "string" }, { name: "token", type: "string", sensitive: true }]} />'
const DEPLOY = '<Run id="deploy" command="deploy" outputs={["url", "secretToken"]} />'
const FORM_AND_DEPLOY = `${FORM}\n\n${DEPLOY}`

/** A machine's files and sessions database, which outlive each start of the app. */
interface Machine {
  readonly files: Record<string, string>
  readonly database: MemorySessionDatabase
  readonly fileSystem: Layer.Layer<FileSystem>
}

const machine = (runbook: string, more: Readonly<Record<string, string>> = {}): Machine => {
  const files = { [RUNBOOK]: runbook, ...more }
  return {
    files,
    database: memorySessionDatabase(),
    fileSystem: Layer.succeed(FileSystem, testFileSystem(files, ["/rb"])),
  }
}

/**
 * One start of the app on `on`: an engine for `program`, closed, with every
 * session, when it ends. With `testClock`, time moves only when the test
 * moves it.
 */
const start = <A, E>(
  on: Machine,
  program: Effect.Effect<A, E, Engine | Caller>,
  {
    cipher = {},
    testClock = false,
    providers = {},
    calls = [],
  }: {
    cipher?: TestCipherOptions
    testClock?: boolean
    /** Each credential provider's script, by name. */
    providers?: Readonly<Record<string, () => ScriptedProvider>>
    /** Where every provider call is noted. */
    calls?: ProviderCall[]
  } = {},
): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Engine.layer({
          registry: REGISTRY,
          appVersion: "0.31.0",
          workingFolders: "/work",
          stateFolders: "/state",
          processEnvironment: {},
        }),
      ),
      Effect.provide(testCredentialProviders(providers, calls)),
      Effect.provide(testSettingsStore()),
      Effect.provide(testSessionStore({ database: on.database, cipher })),
      Effect.provide(on.fileSystem),
      Effect.provideService(Caller, { origin: "person" }),
      testClock ? Effect.provide(TestClock.layer()) : (effect) => effect,
    ),
  )

/** Opens the runbook, and gives the view it opened with and the commands a test sends it. */
const open = Effect.gen(function* () {
  const engine = yield* Engine
  const result = yield* engine.openSession({ path: RUNBOOK })
  if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join("\n"))
  const view = result.session
  const { session } = view
  const recording = yield* Effect.forkChild(Stream.runCollect(engine.events({ session })))
  const target = (block: string) => ({ session, block: blockId(block) })
  return {
    view,
    trust: engine.trustSession({ session, hash: view.trust.hash }),
    start: (block: string) => engine.runBlock(target(block)),
    run: (block: string) =>
      Effect.andThen(
        engine.runBlock(target(block)),
        engine.waitForBlock({ ...target(block), timeoutMillis: 5_000 }),
      ),
    set: (block: string, values: Readonly<Record<string, FieldValue>>) =>
      engine.setValues({ ...target(block), values }),
    reset: (block: string) => engine.resetBlock(target(block)),
    act: (block: string, action: CredentialAction) =>
      engine.actOnCredential({ ...target(block), action }),
    /** The block's credential state once it moves to `tag`. */
    until: (block: string, tag: CredentialStateTag) =>
      engine.events({ session }).pipe(
        Stream.filter(
          ({ event }) =>
            event._tag === "CredentialChanged" && event.block === block && event.state._tag === tag,
        ),
        Stream.runHead,
        Effect.flatMap(Effect.fromOption),
        Effect.timeoutOrElse({
          duration: Duration.seconds(5),
          orElse: () => Effect.die(new Error(`${block} did not move to ${tag}`)),
        }),
        Effect.flatMap(({ event }) =>
          event._tag === "CredentialChanged" ? Effect.succeed(event.state) : Effect.die(event),
        ),
      ),
    block: (block: string) => engine.getBlock({ ...target(block), logLimit: 1_000 }),
    /** Closes the session, and gives every event it logged. */
    close: Effect.andThen(
      engine.closeSession({ session }),
      Effect.map(Fiber.join(recording), (events): ReadonlyArray<EventEnvelope> => events),
    ),
  }
})

/** Trusts the session, fills in and submits the form, and runs `deploy`. */
const fillAndDeploy = Effect.gen(function* () {
  const rb = yield* open
  yield* rb.trust
  yield* rb.set("form", { region: "eu-west-1", token: "form-SECRET" })
  yield* rb.run("form")
  yield* rb.run("deploy")
  return rb.view.session
})

/** Each field's value as a client sees it. */
const valuesOf = (
  fields: ReadonlyArray<{ readonly name: string; readonly value?: unknown }> = [],
) => Object.fromEntries(fields.map((field) => [field.name, field.value]))

const UNTRUSTED = { _tag: "Blocked", by: [{ _tag: "Untrusted" }] } as const

/** Whether `text` shows in any saved payload as it lies in the database. */
const inClear = (database: MemorySessionDatabase, text: string) =>
  database.events().some((row) => new TextDecoder("latin1").decode(row.payload).includes(text))

describe("resuming a session", () => {
  it("finds the values, runs and trust a person left, with no secret in clear on disk", async () => {
    const on = machine(FORM_AND_DEPLOY)
    const first = await start(on, fillAndDeploy)
    for (const text of ["form-SECRET", "tok-SECRET", "eu-west-1", "deploying"])
      expect(inClear(on.database, text)).toBe(false)

    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        const form = yield* rb.block("form")
        const deploy = yield* rb.block("deploy")
        return { view: rb.view, form, deploy, events: yield* rb.close }
      }),
    )
    expect(resumed.view.session).toBe(first)
    expect(resumed.view.trust.trusted).toBe(true)
    expect(resumed.view.resumed?.problems).toEqual([])
    expect(valuesOf(resumed.form.fields)).toEqual({
      region: { _tag: "Shown", value: "eu-west-1" },
      token: { _tag: "Hidden" },
    })
    expect(resumed.form.status).toEqual({ _tag: "Done", outcome: "success" })
    expect(resumed.deploy.status).toEqual({ _tag: "Done", outcome: "success" })
    expect(resumed.deploy.outputs).toEqual({
      url: { _tag: "Shown", value: "https://app" },
      secretToken: { _tag: "Hidden" },
    })
    expect(resumed.deploy.log).toMatchObject({
      offset: 0,
      total: 1,
      lines: [{ stream: "stdout", text: "deploying" }],
    })
    // The log alone tells a client what the resumed session holds.
    const deployEvents = resumed.events.flatMap(({ event }) =>
      "block" in event && event.block === "deploy" ? [event._tag] : [],
    )
    expect(deployEvents).toEqual(
      expect.arrayContaining(["LogLines", "OutputsPublished", "BlockStatusChanged"]),
    )
  })

  it("brings a session never trusted back untrusted, with its values", async () => {
    const on = machine(FORM_AND_DEPLOY)
    await start(
      on,
      Effect.flatMap(open, (rb) => rb.set("form", { region: "eu-west-1" })),
    )
    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return { view: rb.view, form: yield* rb.block("form"), deploy: yield* rb.block("deploy") }
      }),
    )
    expect(resumed.view.trust.trusted).toBe(false)
    expect(valuesOf(resumed.form.fields).region).toEqual({ _tag: "Shown", value: "eu-west-1" })
    expect(resumed.deploy.status).toEqual(UNTRUSTED)
  })

  it("brings a changed runbook back untrusted, with its values and without its runs, and runs nothing until trusted", async () => {
    const on = machine(FORM_AND_DEPLOY)
    await start(on, fillAndDeploy)
    on.files[RUNBOOK] = `${FORM_AND_DEPLOY}\n\n<Note>Changed.</Note>`

    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        const before = {
          form: yield* rb.block("form"),
          deploy: (yield* rb.block("deploy")).status,
          refused: yield* rb.start("deploy"),
        }
        yield* rb.trust
        return { view: rb.view, before, after: (yield* rb.run("deploy")).block.status }
      }),
    )
    expect(resumed.view.trust.trusted).toBe(false)
    expect(resumed.view.resumed?.problems).toEqual([
      { _tag: "RunbookChanged", blocks: [blockId("form"), blockId("deploy")] },
    ])
    expect(valuesOf(resumed.before.form.fields).region).toEqual({
      _tag: "Shown",
      value: "eu-west-1",
    })
    expect(resumed.before.deploy).toEqual(UNTRUSTED)
    expect(resumed.before.refused).toEqual({ _tag: "Refused", reason: UNTRUSTED })
    expect(resumed.after).toEqual({ _tag: "Done", outcome: "success" })
  })

  it("drops the run of a block whose script changed, and the session's trust; the other blocks keep theirs", async () => {
    const on = machine(
      `<Run id="deploy" command="deploy" path="deploy.sh" />\n\n<Run id="check" command="deploy" />`,
      { "/rb/deploy.sh": "echo 1" },
    )
    await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        yield* rb.trust
        yield* rb.run("deploy")
        yield* rb.run("check")
      }),
    )
    on.files["/rb/deploy.sh"] = "echo 2"
    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return {
          view: rb.view,
          deploy: (yield* rb.block("deploy")).status,
          check: (yield* rb.block("check")).status,
        }
      }),
    )
    expect(resumed.view.trust.trusted).toBe(false)
    expect(resumed.view.resumed?.problems).toEqual([
      { _tag: "RunbookChanged", blocks: [blockId("deploy")] },
    ])
    expect(resumed.deploy).toEqual(UNTRUSTED)
    expect(resumed.check).toEqual({ _tag: "Done", outcome: "success" })
  })

  it("keeps the values of a session an older version saved and drops its runs (open decision 6)", async () => {
    const on = machine(FORM_AND_DEPLOY)
    await start(on, fillAndDeploy)
    for (const row of on.database.events()) on.database.put({ ...row, version: 0 })

    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return { view: rb.view, form: yield* rb.block("form"), deploy: yield* rb.block("deploy") }
      }),
    )
    expect(resumed.view.resumed?.problems).toEqual([
      { _tag: "OlderVersion", version: 0, blocks: [blockId("form"), blockId("deploy")] },
    ])
    expect(resumed.view.trust.trusted).toBe(true)
    expect(valuesOf(resumed.form.fields).region).toEqual({ _tag: "Shown", value: "eu-west-1" })
    expect(resumed.form.status).toEqual({ _tag: "Idle" })
    expect(resumed.deploy.status).toEqual({ _tag: "Idle" })
    // Saved again as this version holds it: no run is offered a second time.
    expect(on.database.events().map(({ block, kind, version }) => [block, kind, version])).toEqual([
      ["form", "values", SAVED_SESSION_VERSION],
    ])
  })

  it("opens a session a newer version saved with nothing of it taken back", async () => {
    const on = machine(FORM_AND_DEPLOY)
    await start(on, fillAndDeploy)
    for (const row of on.database.events())
      on.database.put({ ...row, version: SAVED_SESSION_VERSION + 1, payload: Uint8Array.of(7) })

    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return { view: rb.view, form: yield* rb.block("form"), deploy: yield* rb.block("deploy") }
      }),
    )
    expect(resumed.view.resumed?.problems).toEqual([
      {
        _tag: "NewerVersion",
        version: SAVED_SESSION_VERSION + 1,
        blocks: [blockId("form"), blockId("deploy")],
      },
    ])
    expect(resumed.view.trust.trusted).toBe(true)
    expect(valuesOf(resumed.form.fields)).toEqual({})
    expect(resumed.deploy.status).toEqual({ _tag: "Idle" })
  })

  it("leaves unread what the system's key no longer opens", async () => {
    const on = machine(FORM_AND_DEPLOY)
    await start(on, fillAndDeploy)
    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return { view: rb.view, form: yield* rb.block("form") }
      }),
      { cipher: { key: 2 } },
    )
    expect(resumed.view.resumed?.problems).toEqual([
      { _tag: "Unreadable", blocks: [blockId("form"), blockId("deploy")] },
    ])
    expect(valuesOf(resumed.form.fields)).toEqual({})
  })

  it("saves only the session's row where the system cannot encrypt, and brings back its trust", async () => {
    const on = machine(FORM_AND_DEPLOY)
    const unencrypted = { cipher: { available: false } }
    await start(on, fillAndDeploy, unencrypted)
    expect(on.database.events()).toEqual([])
    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return { view: rb.view, form: yield* rb.block("form") }
      }),
      unencrypted,
    )
    expect(resumed.view.trust.trusted).toBe(true)
    expect(resumed.view.resumed?.problems).toEqual([])
    expect(valuesOf(resumed.form.fields)).toEqual({})
  })

  it(`saves a run's log as its last ${MAX_SAVED_LOG_LINES} lines and ${MAX_SAVED_LOG_CHARS} characters`, async () => {
    const on = machine('<Run id="noisy" command="noisy" />\n\n<Run id="wide" command="wide" />')
    await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        yield* rb.trust
        yield* rb.run("noisy")
        yield* rb.run("wide")
      }),
    )
    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return { noisy: (yield* rb.block("noisy")).log, wide: (yield* rb.block("wide")).log }
      }),
    )
    expect(resumed.noisy?.offset).toBe(600 - MAX_SAVED_LOG_LINES)
    expect(resumed.noisy?.total).toBe(600)
    expect(resumed.noisy?.lines.map(({ text }) => text)).toEqual(
      Array.from(
        { length: MAX_SAVED_LOG_LINES },
        (_, n) => `line ${n + 600 - MAX_SAVED_LOG_LINES}`,
      ),
    )
    expect(resumed.wide).toEqual({
      offset: 2,
      total: 3,
      lines: [{ stream: "stdout", text: "c".repeat(40_000) }],
    })
  })

  it("brings back a run the app closed on as cancelled, and one it stopped on without closing as failed", async () => {
    const on = machine('<Run id="hang" command="hang" />')
    await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        yield* rb.trust
        yield* rb.start("hang")
      }),
    )
    const statusNow = Effect.flatMap(open, (rb) => rb.block("hang"))
    expect((await start(on, statusNow)).status).toEqual({
      _tag: "Failed",
      error: new TaskCancelled({}),
    })

    const [saved] = on.database.events()
    if (saved === undefined) throw new Error("The run was not saved.")
    on.database.put({ ...saved, payload: testCiphertext('{"_tag":"Running"}') })
    expect((await start(on, statusNow)).status).toEqual({
      _tag: "Failed",
      error: new TaskFailed({ message: "Runbooks stopped before the run ended." }),
    })
  })

  it("saves a reset: the block comes back as it was before it ran", async () => {
    const on = machine(FORM_AND_DEPLOY)
    await start(on, fillAndDeploy)
    await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        yield* rb.reset("form")
        yield* rb.reset("deploy")
      }),
    )
    const resumed = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return { form: yield* rb.block("form"), deploy: (yield* rb.block("deploy")).status }
      }),
    )
    expect(valuesOf(resumed.form.fields).region).toEqual({ _tag: "Shown", value: "eu-west-1" })
    expect(resumed.form.status).toEqual({ _tag: "Idle" })
    expect(resumed.deploy).toEqual({ _tag: "Idle" })
  })

  it("starts a session of its own for a runbook open already (open decision 18), and resumes the one closed last", async () => {
    const on = machine(FORM_AND_DEPLOY)
    const ids = await start(
      on,
      Effect.gen(function* () {
        const a = yield* open
        yield* a.set("form", { region: "eu-west-1" })
        yield* TestClock.adjust("1 second")
        const b = yield* open
        yield* TestClock.adjust("1 second")
        yield* a.close
        const c = yield* open
        return { a: a.view, b: b.view, c: c.view }
      }),
      { testClock: true },
    )
    expect(ids.b.session).not.toBe(ids.a.session)
    expect(ids.b.resumed).toBeUndefined()
    expect(ids.c.session).toBe(ids.a.session)
    expect(ids.c.resumed).toBeDefined()
  })

  it("goes on when the database refuses every save", async () => {
    const on = machine(FORM_AND_DEPLOY)
    for (const call of ["putSession", "putEvent", "deleteEvent", "latest", "events"] as const)
      on.database.failing.add(call)
    const deployed = await start(
      on,
      Effect.gen(function* () {
        yield* fillAndDeploy
        const rb = yield* open
        return rb.view.resumed
      }),
    )
    expect(deployed).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const CLOUD_INFO: ProviderInfo = {
  methods: [],
  levels: [
    { name: "account", label: "Account", chosen: "afterSignIn" },
    { name: "role", label: "Role", chosen: "afterSignIn" },
  ],
  sources: [],
  requirements: [],
  names: ["CLOUD_TOKEN", "CLOUD_ACCOUNT", "account", "token"],
}

const WHO: Identity = {
  principal: "arn:cloud::111:role/Admin",
  kind: "role",
  method: "sso",
  targets: { account: { id: "111", name: "acct-111" }, role: { id: "Admin", name: "Admin" } },
}

const CLOUD_ENV: CredentialEnv = {
  values: [
    { name: "CLOUD_TOKEN", value: Redacted.make("tok-SECRET"), sensitive: true, to: ["env"] },
    { name: "CLOUD_ACCOUNT", value: Redacted.make("111"), sensitive: false, to: ["env"] },
  ],
  expiresAt: Option.none(),
}

/** A cloud provider that finds the login in what `finds` accepts, and gives `CLOUD_ENV`. */
const cloud = (finds: (source: ResolvedSource) => boolean) => (): ScriptedProvider => ({
  info: CLOUD_INFO,
  env: Effect.succeed(CLOUD_ENV),
  detect: (sources) =>
    Effect.succeed(
      Option.fromUndefinedOr(
        sources.find(finds) === undefined ? undefined : { identity: WHO, source: "env" },
      ),
    ),
})

/** Finds the login in the environment, as on the first start. */
const inEnvironment = cloud((source) => source.kind === "env")
/** Finds the login only in the values the block's own `env` gave before. */
const inSavedValues = cloud(
  (source) =>
    source.kind === "values" &&
    source.from === "cloud" &&
    source.values.CLOUD_TOKEN !== undefined &&
    Redacted.value(source.values.CLOUD_TOKEN) === "tok-SECRET",
)
const findsNothing = cloud(() => false)

const PINNED = '<CloudLogin id="cloud" account="111" role="Admin" />'

/** Opens the runbook, trusts it, and waits for `cloud` to be Ready. */
const signedIn = Effect.gen(function* () {
  const rb = yield* open
  yield* rb.trust
  return yield* rb.until("cloud", "Ready")
})

/** Each detection source `cloud`'s provider was asked to look in, by kind. */
const detectedIn = (calls: ReadonlyArray<ProviderCall>) =>
  calls.flatMap(({ block, method, args }) =>
    block === "cloud" && method === "detect"
      ? [(args[0] as ReadonlyArray<ResolvedSource>).map((source) => source.kind)]
      : [],
  )

describe("resuming a credential", () => {
  it("brings a Ready login back Ready once trusted, its provider finding it in the values it gave", async () => {
    const on = machine(PINNED)
    await start(on, signedIn, { providers: { cloud: inEnvironment } })
    expect(inClear(on.database, "tok-SECRET")).toBe(false)

    const calls: ProviderCall[] = []
    const state = await start(
      on,
      Effect.flatMap(open, (rb) => rb.until("cloud", "Ready")),
      { providers: { cloud: inSavedValues }, calls },
    )
    expect(state).toMatchObject({ _tag: "Ready", source: "env", identity: WHO })
    expect(detectedIn(calls)).toEqual([["values"]])
  })

  it("brings back with no click a login the person confirmed for a block that pins nothing (open decision 7)", async () => {
    const on = machine('<CloudLogin id="cloud" />')
    await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        yield* rb.trust
        yield* rb.until("cloud", "Found")
        yield* rb.act("cloud", { _tag: "Confirm" })
        yield* rb.until("cloud", "Ready")
      }),
      { providers: { cloud: inEnvironment } },
    )
    const state = await start(
      on,
      Effect.flatMap(open, (rb) => rb.until("cloud", "Ready")),
      { providers: { cloud: inSavedValues } },
    )
    expect(state._tag).toBe("Ready")
  })

  it("detects anew when the provider no longer finds the saved login, and forgets it once signed out", async () => {
    const on = machine(PINNED)
    await start(on, signedIn, { providers: { cloud: inEnvironment } })
    const calls: ProviderCall[] = []
    await start(
      on,
      Effect.flatMap(open, (rb) => rb.until("cloud", "SignedOut")),
      { providers: { cloud: findsNothing }, calls },
    )
    expect(detectedIn(calls)).toEqual([["values"], ["env"]])
    expect(on.database.events().filter(({ kind }) => kind === "credential")).toEqual([])
  })

  it("keeps a saved login through a start whose provider cannot be reached", async () => {
    const on = machine(PINNED)
    await start(on, signedIn, { providers: { cloud: inEnvironment } })
    await start(
      on,
      Effect.flatMap(open, (rb) => rb.until("cloud", "Unavailable")),
      { providers: {} },
    )
    const state = await start(on, signedIn, { providers: { cloud: inSavedValues } })
    expect(state._tag).toBe("Ready")
  })

  it("opens no provider for a resumed session that is not trusted", async () => {
    const on = machine(PINNED)
    await start(on, signedIn, { providers: { cloud: inEnvironment } })
    on.files[RUNBOOK] = `${PINNED}\n\n<Note>Changed.</Note>`
    const calls: ProviderCall[] = []
    const view = await start(
      on,
      Effect.gen(function* () {
        const rb = yield* open
        return yield* rb.block("cloud")
      }),
      { providers: { cloud: inSavedValues }, calls },
    )
    // A trusted session starts the block's lifecycle in the step that trusts it.
    expect(view.credential).toBeUndefined()
    expect(view.status).toEqual(UNTRUSTED)
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Saves `row` in the machine's database as it would be after time passed. */
const putSession = (on: Machine, row: SessionRow) =>
  Effect.runPromise(
    Effect.flatMap(SessionDatabase, (db) => db.putSession(row)).pipe(
      Effect.provide(on.database.layer),
    ),
  )

/** Opens the runbook in one start, gives it a value and files in both its folders, and gives its row. */
const leftAlone = async (on: Machine) => {
  const id = await start(
    on,
    Effect.gen(function* () {
      const rb = yield* open
      yield* rb.set("form", { region: "eu-west-1" })
      return rb.view.session
    }),
  )
  on.files[`/work/${id}/repo/main.tf`] = "terraform {}"
  on.files[`/state/${id}/cloud/token`] = "tok-SECRET"
  const [row] = on.database.sessions()
  if (row === undefined) throw new Error("The session was not saved.")
  return row
}

const STALE = Date.now() - MAX_SESSION_AGE_MILLIS - 60_000

describe("retention", () => {
  it(`drops a session unused for ${MAX_SESSION_AGE_MILLIS / 86_400_000} days, with its folders, when the app starts`, async () => {
    const on = machine(FORM_AND_DEPLOY)
    const row = await leftAlone(on)
    await putSession(on, { ...row, usedAt: STALE })

    const view = await start(
      on,
      Effect.map(open, (rb) => rb.view),
    )
    expect(Object.keys(on.files).filter((file) => file.includes(row.id))).toEqual([])
    expect(String(view.session)).not.toBe(row.id)
    expect(view.resumed).toBeUndefined()
    expect(on.database.sessions().map(({ id }) => id)).toEqual([view.session])
  })

  it("keeps a session used since, and its folders", async () => {
    const on = machine(FORM_AND_DEPLOY)
    const row = await leftAlone(on)
    const view = await start(
      on,
      Effect.map(open, (rb) => rb.view),
    )
    expect(String(view.session)).toBe(row.id)
    expect(on.files[`/work/${row.id}/repo/main.tf`]).toBe("terraform {}")
  })

  it("keeps a session whose folders cannot be deleted, for the next start to try again", async () => {
    const on = machine(FORM_AND_DEPLOY)
    const row = await leftAlone(on)
    await putSession(on, { ...row, usedAt: STALE })
    const stuck: Machine = {
      ...on,
      fileSystem: Layer.succeed(FileSystem, {
        ...testFileSystem(on.files, ["/rb"]),
        rm: (folder) =>
          Effect.fail(new FileWriteError({ path: folder, cause: new Error("Device busy") })),
      }),
    }
    await start(stuck, Effect.void)
    expect(on.database.sessions().map(({ id }) => id)).toEqual([row.id])
    await start(on, Effect.void)
    expect(on.database.sessions()).toEqual([])
  })

  it("deletes no folder for a row whose id the engine did not make", async () => {
    const on = machine(FORM_AND_DEPLOY)
    await putSession(on, {
      id: "../rb",
      runbook: RUNBOOK,
      createdAt: 0,
      usedAt: STALE,
      trusted: Option.none(),
    })
    await start(on, Effect.void)
    expect(on.files[RUNBOOK]).toBe(FORM_AND_DEPLOY)
    expect(on.database.sessions()).toEqual([])
  })
})
