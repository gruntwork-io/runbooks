import { describe, expect, it } from "bun:test"
import { Effect, Queue, Schema } from "effect"
import { BlockView, DocumentView, SessionId, Settings } from "@runbooks/core/protocol"
import { makeEngineClient } from "./engine.ts"
import { dies, type FakeMain, fails, fakeMain } from "./fakeMain.ts"
import { type Following, followingOf } from "./following.ts"
import type { ScriptFilesShown } from "./scriptFiles.ts"

// The window reading a block's script files for its source view, against a main
// that answers `GetSession`, `GetDocument` and `GetScriptFiles` as a test
// says and streams the events a test sends. Each value is the JSON main
// sends.

const SESSION = "3fa85f64-5717-4562-b3fc-2c963f66afa6"
const DRAWN = `sha256:${"1".repeat(64)}`
const RELOADED = `sha256:${"2".repeat(64)}`
const GREET = Schema.decodeSync(BlockView.fields.block)("greet")

const SETTINGS = Schema.decodeUnknownSync(Settings)({
  theme: "system",
  instructionMode: false,
  runbookWidth: null,
  askAboutGeneratedFiles: true,
  caBundleFile: null,
  proxy: null,
  agentAccess: false,
  confirmAgentRuns: true,
  recentGitHubHosts: [],
  lastSelectedGitHubHost: null,
  recentGitLabHosts: [],
  lastSelectedGitLabHost: null,
})

const documentOf = (hash: string) => ({
  hash,
  tree: { type: "root", children: [] },
  blocks: [],
  warnings: [],
})

/** The runbook the window opened, whose hash is DRAWN. */
const OPENED = Schema.decodeUnknownSync(DocumentView)(documentOf(DRAWN))

/** greet's script file as `GetScriptFiles` gives it, from the runbook at `document`. */
const filesOf = (document: string, text: string) => ({
  document,
  files: [{ path: "greet.sh", language: "bash", text }],
})

/** What main answers: the session, the runbook it holds now, and greet's script files. */
interface Engine {
  document: unknown
  files: unknown
}

const mainFor = (engine: Engine) =>
  fakeMain((tag) => {
    switch (tag) {
      case "GetSession":
        return {
          session: SESSION,
          name: "deploy",
          path: "/runbooks/deploy/runbook.mdx",
          sequence: 4,
          trust: { trusted: true, hash: DRAWN },
          blocks: [],
          warnings: [],
        }
      case "GetDocument":
        return engine.document
      case "GetScriptFiles":
        return engine.files
      default:
        return undefined
    }
  })

let sequence = 4
/** The session reloaded its runbook, now at `hash`, as main sends it. */
const reloaded = (hash: string) => ({
  session: SESSION,
  sequence: ++sequence,
  at: "2026-11-27T12:00:00.000Z",
  event: { _tag: "DocumentChanged", hash },
})

/** What a test sees of the window: the follower, and a wait for a change that holds. */
interface Watching {
  readonly following: Following
  /** Waits until `holds` of the page drawn and what greet's views show. */
  readonly until: (
    holds: (drawn: string | undefined, shown: ScriptFilesShown | undefined) => boolean,
  ) => Effect.Effect<void>
  /** Each page drawn and what greet's views showed with it, at each change. */
  readonly seen: ReadonlyArray<readonly [string | undefined, ScriptFilesShown | undefined]>
  /** Each `GetScriptFiles` the window sent. */
  readonly asked: () => ReadonlyArray<unknown>
}

/**
 * Follows the session `main` serves and runs `test`; `before` runs
 * before the window starts following it.
 */
const watching = (
  main: FakeMain,
  test: (watching: Watching) => Effect.Effect<void>,
  before: (following: Following) => void = () => {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* makeEngineClient(main.bridge)
        const following = followingOf(engine, Schema.decodeSync(SessionId)(SESSION), {
          document: OPENED,
          settings: SETTINGS,
        })
        const changes = yield* Queue.unbounded<void>()
        const seen: Array<readonly [string | undefined, ScriptFilesShown | undefined]> = []
        following.scriptFiles.subscribe(() => {
          seen.push([following.live.get().document?.hash, following.scriptFiles.get(GREET)])
          Queue.offerUnsafe(changes, undefined)
        })
        before(following)
        yield* Effect.acquireRelease(Effect.sync(following.start), (stop) => Effect.sync(stop))
        const until: Watching["until"] = (holds) =>
          Effect.gen(function* () {
            while (!holds(following.live.get().document?.hash, following.scriptFiles.get(GREET)))
              yield* Queue.take(changes)
          })
        yield* test({
          following,
          until,
          seen,
          asked: () =>
            main.asked.flatMap(({ tag, payload }) => (tag === "GetScriptFiles" ? [payload] : [])),
        })
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

const textOf = (shown: ScriptFilesShown | undefined) =>
  shown?._tag === "Read" ? shown.files[0]?.text : undefined

/** Long enough for an ask the window sent to reach main. */
const settle = Effect.sleep("30 millis")

describe("the window reading a block's script files for its source view", () => {
  it("reads nothing for a block with no view open, whatever the page draws", async () => {
    const engine: Engine = { document: documentOf(DRAWN), files: filesOf(DRAWN, "echo v1\n") }
    const main = mainFor(engine)
    await watching(main, ({ following, until, asked }) =>
      Effect.gen(function* () {
        yield* until((drawn) => drawn === DRAWN)
        engine.document = documentOf(RELOADED)
        main.stream("Events", [reloaded(RELOADED)])
        yield* until((drawn) => drawn === RELOADED)
        yield* settle
        expect(asked()).toEqual([])
        expect(following.scriptFiles.get(GREET)).toBeUndefined()
      }),
    )
  })

  it("reads a block's script files once a view opens, as the session holds them, for the page drawn", async () => {
    const main = mainFor({
      document: documentOf(DRAWN),
      files: filesOf(DRAWN, "echo {{ .inputs.token }}\n"),
    })
    await watching(main, ({ following, until, asked }) =>
      Effect.gen(function* () {
        yield* until((drawn) => drawn === DRAWN)
        following.scriptFiles.open(GREET)
        expect(following.scriptFiles.get(GREET)).toEqual({ _tag: "Reading" })
        yield* until((_, shown) => shown?._tag === "Read")
        expect<unknown>(following.scriptFiles.get(GREET)).toEqual({
          _tag: "Read",
          files: [{ path: "greet.sh", language: "bash", text: "echo {{ .inputs.token }}\n" }],
        })
        // React reads the same value until it changes.
        expect(following.scriptFiles.get(GREET)).toBe(following.scriptFiles.get(GREET))
        expect(asked()).toEqual([{ session: SESSION, block: "greet" }])
      }),
    )
  })

  it("reads them again each time the page draws another runbook, and shows none of the one before with it", async () => {
    const engine: Engine = { document: documentOf(DRAWN), files: filesOf(DRAWN, "echo v1\n") }
    const main = mainFor(engine)
    await watching(main, ({ following, until, seen, asked }) =>
      Effect.gen(function* () {
        yield* until((drawn) => drawn === DRAWN)
        following.scriptFiles.open(GREET)
        yield* until((_, shown) => textOf(shown) === "echo v1\n")
        engine.document = documentOf(RELOADED)
        engine.files = filesOf(RELOADED, "echo v2\n")
        main.stream("Events", [reloaded(RELOADED)])
        yield* until((drawn, shown) => drawn === RELOADED && textOf(shown) === "echo v2\n")
        expect(
          seen.filter(([drawn, shown]) => drawn === RELOADED && textOf(shown) === "echo v1\n"),
        ).toEqual([])
        expect(seen.some(([drawn, shown]) => drawn === RELOADED && shown?._tag === "Reading")).toBe(
          true,
        )
        expect(asked()).toHaveLength(2)
      }),
    )
  })

  it("drops a read of a runbook the page does not draw, and shows the read of the one it draws next", async () => {
    // The engine reloaded the runbook before the window read the event that says so.
    const engine: Engine = {
      document: documentOf(RELOADED),
      files: filesOf(RELOADED, "echo v2\n"),
    }
    const main = mainFor(engine)
    await watching(main, ({ following, until, asked }) =>
      Effect.gen(function* () {
        yield* until((drawn) => drawn === DRAWN)
        following.scriptFiles.open(GREET)
        while (asked().length === 0) yield* settle
        yield* settle
        expect(following.scriptFiles.get(GREET)).toEqual({ _tag: "Reading" })
        main.stream("Events", [reloaded(RELOADED)])
        yield* until((drawn, shown) => drawn === RELOADED && textOf(shown) === "echo v2\n")
        expect(asked()).toHaveLength(2)
      }),
    )
  })

  it("reads once the page draws a runbook, for a view open before", async () => {
    const main = mainFor({ document: documentOf(DRAWN), files: filesOf(DRAWN, "echo v1\n") })
    await watching(
      main,
      ({ until, asked }) =>
        Effect.gen(function* () {
          yield* until((drawn, shown) => drawn === DRAWN && textOf(shown) === "echo v1\n")
          expect(asked()).toHaveLength(1)
        }),
      (following) => {
        following.scriptFiles.open(GREET)
        expect(following.scriptFiles.get(GREET)).toEqual({ _tag: "Reading" })
        expect(main.asked.filter(({ tag }) => tag === "GetScriptFiles")).toEqual([])
      },
    )
  })

  it("keeps a block's script files while any of its views is open, and reads nothing once the last closes", async () => {
    const engine: Engine = { document: documentOf(DRAWN), files: filesOf(DRAWN, "echo v1\n") }
    const main = mainFor(engine)
    await watching(main, ({ following, until, asked }) =>
      Effect.gen(function* () {
        yield* until((drawn) => drawn === DRAWN)
        const closeFirst = following.scriptFiles.open(GREET)
        const closeSecond = following.scriptFiles.open(GREET)
        yield* until((_, shown) => textOf(shown) === "echo v1\n")
        closeFirst()
        closeFirst()
        expect(textOf(following.scriptFiles.get(GREET))).toBe("echo v1\n")
        closeSecond()
        expect(following.scriptFiles.get(GREET)).toBeUndefined()
        engine.document = documentOf(RELOADED)
        main.stream("Events", [reloaded(RELOADED)])
        yield* until((drawn) => drawn === RELOADED)
        yield* settle
        expect(asked()).toHaveLength(1)
      }),
    )
  })

  it.each([
    [
      "the session is gone",
      fails({ _tag: "UnknownSession", session: SESSION }),
      "This runbook's session closed, so its script files can't be shown.",
    ],
    [
      "the engine has no such block",
      fails({ _tag: "UnknownBlock", session: SESSION, block: "greet" }),
      "The engine has no block greet in this runbook's session, so it can't show its script files.",
    ],
    [
      "the call dies",
      dies({ name: "Error", message: "the script could not be read" }),
      "The engine failed, so the script can't be shown: the script could not be read",
    ],
  ])("says why it shows no script files when %s", async (_when, answer, line) => {
    const main = mainFor({ document: documentOf(DRAWN), files: answer })
    await watching(main, ({ following, until }) =>
      Effect.gen(function* () {
        yield* until((drawn) => drawn === DRAWN)
        following.scriptFiles.open(GREET)
        yield* until((_, shown) => shown?._tag === "Failed")
        expect(following.scriptFiles.get(GREET)).toEqual({ _tag: "Failed", line })
      }),
    )
  })
})
