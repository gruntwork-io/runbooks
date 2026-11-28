import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Queue, Schema } from "effect"
import { DocumentView, type Instruction, SessionId, Settings } from "@runbooks/core/protocol"
import { makeEngineClient } from "./engine.ts"
import { dies, type FakeMain, fails, fakeMain } from "./fakeMain.ts"
import { EVENTS_AHEAD, follow, type Live } from "./live.ts"
import { makeSettingsStore, type SettingsStore } from "./settings.ts"

// The window following a session, against a main that answers the engine's
// commands from `engine` below and streams the events a test sends. Each
// value is the JSON main sends.

const SESSION = Schema.decodeSync(SessionId)("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const HASH = `sha256:${"0".repeat(64)}`
const RELOADED = `sha256:${"1".repeat(64)}`

/** A runbook as `GetDocument` gives it: its hash, a heading, and a task block for each id. */
const documentOf = (hash: string, heading: string, ids: ReadonlyArray<string> = []) => ({
  hash,
  tree: {
    type: "root",
    children: [
      { type: "heading", depth: 2, children: [{ type: "text", value: heading }] },
      ...ids.map((_, index) => ({ type: "block", index, children: [] })),
    ],
  },
  blocks: ids.map((id, index) => ({
    _tag: "Configured",
    index,
    tag: "Example",
    block: "Example",
    class: "task",
    id,
    span: { start: { line: index + 3, column: 1 }, end: { line: index + 3, column: 20 } },
    step: true,
    effects: [],
  })),
  warnings: [],
})

/** The runbook the window opened, whose hash the session's view has. */
const OPENED = Schema.decodeUnknownSync(DocumentView)({
  hash: HASH,
  tree: { type: "root", children: [] },
  blocks: [],
  warnings: [],
})

/** What the engine holds of each block, which `GetBlock` answers and a test changes. */
type Engine = Record<string, Record<string, unknown>>

const task = (block: string, fields: Record<string, unknown> = {}) => ({
  block,
  tag: "Example",
  class: "task",
  status: { _tag: "Idle" },
  actions: ["run"],
  outputs: {},
  ...fields,
})

const sessionView = (engine: Engine, fields: Record<string, unknown> = {}) => ({
  session: SESSION,
  name: "deploy",
  path: "/runbooks/deploy/runbook.mdx",
  sequence: 4,
  trust: { trusted: true, hash: HASH },
  blocks: [
    ...Object.values(engine).map(({ block, tag, class: kind, status, actions }) => ({
      block,
      tag,
      class: kind,
      status,
      actions,
    })),
    { block: "note", tag: "Note", class: "display", actions: [] },
  ],
  warnings: [],
  ...fields,
})

const answering =
  (engine: Engine, session: Record<string, unknown> = {}) =>
  (tag: string, payload: unknown) => {
    switch (tag) {
      case "GetSession":
        return sessionView(engine, session)
      case "GetBlock": {
        const { block, logOffset = 0 } = payload as { block: string; logOffset?: number }
        const view = engine[block]
        const log = view?.log as { total: number; lines: unknown[] } | undefined
        if (log === undefined) return view
        return {
          ...view,
          log: { ...log, offset: logOffset, lines: log.lines.slice(logOffset, logOffset + 200) },
        }
      }
      default:
        return undefined
    }
  }

let sequence = 4
/** An event as main sends it, with the next sequence. */
const event = (value: Record<string, unknown>) => ({
  session: SESSION,
  sequence: ++sequence,
  at: "2026-11-26T12:00:00.000Z",
  event: value,
})

/** The settings as the engine sends them, with instruction mode `on`. */
const settingsWith = (on: boolean, fields: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(Settings)({
    theme: "system",
    instructionMode: on,
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
    ...fields,
  })

/**
 * Follows the session `main` answers for, in the settings `settings` hold
 * (none read, by default), running `test` with each state the follower
 * shows, in turn, and stops following when it returns. `shown` is called
 * with each state as the follower shows it.
 */
const following = (
  main: FakeMain,
  test: (next: Effect.Effect<Live>) => Effect.Effect<void>,
  {
    settings = makeSettingsStore(undefined),
    shown: onShow = () => {},
  }: { readonly settings?: SettingsStore; readonly shown?: (live: Live) => void } = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* makeEngineClient(main.bridge)
        const shown = yield* Queue.unbounded<Live>()
        const fiber = yield* Effect.forkScoped(
          follow(engine, SESSION, OPENED, settings, (live) => {
            Queue.offerUnsafe(shown, live)
            onShow(live)
          }),
        )
        yield* test(Queue.take(shown))
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.timeout("2 seconds")),
  )

const statusOf = (live: Live, block: string) => live.blocks.get(block)?.status?._tag

/** Each block the window asked the engine for (`GetBlock`), in turn. */
const blocksRead = (main: FakeMain) =>
  main.asked.flatMap(({ tag, payload }) =>
    tag === "GetBlock" ? [(payload as { block: string }).block] : [],
  )

/** What `count` gives once it has given the same number five times running, 10 ms apart. */
const steady = (count: () => number) =>
  Effect.gen(function* () {
    let last = count()
    let same = 0
    while (same < 5) {
      yield* Effect.sleep("10 millis")
      const now = count()
      same = now === last ? same + 1 : 0
      last = now
    }
    return last
  })

const code = (text: string): Instruction => [{ kind: "code", language: "bash", code: text }]

describe("the window following a session", () => {
  it("shows each block with a lifecycle as the engine has it, and starts its events where the session's view ends", async () => {
    const engine: Engine = {
      greet: task("greet"),
      later: task("later", { status: { _tag: "Running" }, actions: ["cancel", "reset"] }),
    }
    const main = fakeMain(answering(engine))
    await following(main, (next) =>
      Effect.gen(function* () {
        const live = yield* next
        expect([...live.blocks.keys()].sort()).toEqual(["greet", "later"])
        expect(statusOf(live, "later")).toBe("Running")
        expect(live.blocks.get("later")?.actions).toEqual(["cancel", "reset"])
        expect(main.asked.filter(({ tag }) => tag === "Events")).toEqual([
          { tag: "Events", payload: { session: SESSION, after: 4 } },
        ])
      }),
    )
  })

  it("has asked for the session's events by the time it first shows the session", async () => {
    const main = fakeMain(answering({ greet: task("greet") }))
    const askedWhenShown: string[][] = []
    await following(
      main,
      (next) =>
        Effect.gen(function* () {
          yield* next
        }),
      { shown: () => askedWhenShown.push(main.asked.map(({ tag }) => tag)) },
    )
    expect(askedWhenShown[0]).toContain("Events")
  })

  it("reads every event a session logged when its view reflects none", async () => {
    const main = fakeMain(answering({ greet: task("greet") }, { sequence: undefined }))
    await following(main, (next) =>
      Effect.gen(function* () {
        yield* next
        expect(main.asked.filter(({ tag }) => tag === "Events")).toEqual([
          { tag: "Events", payload: { session: SESSION } },
        ])
      }),
    )
  })

  it("moves a block from Ready to Running to Done as its events say it changed", async () => {
    const engine: Engine = { greet: task("greet"), other: task("other") }
    const main = fakeMain(answering(engine))
    await following(main, (next) =>
      Effect.gen(function* () {
        expect(statusOf(yield* next, "greet")).toBe("Idle")
        engine.greet = task("greet", { status: { _tag: "Running" }, actions: ["cancel", "reset"] })
        main.stream("Events", [
          event({ _tag: "BlockStatusChanged", block: "greet", status: { _tag: "Running" } }),
        ])
        const running = yield* next
        expect(statusOf(running, "greet")).toBe("Running")
        expect(running.blocks.get("greet")?.actions).toEqual(["cancel", "reset"])
        engine.greet = task("greet", {
          status: { _tag: "Done", outcome: "success" },
          actions: ["run", "reset"],
        })
        main.stream("Events", [
          event({
            _tag: "BlockStatusChanged",
            block: "greet",
            status: { _tag: "Done", outcome: "success" },
          }),
        ])
        const done = yield* next
        expect(statusOf(done, "greet")).toBe("Done")
        // A block no event named is not read again.
        expect(
          main.asked.filter(
            ({ tag, payload }) =>
              tag === "GetBlock" && (payload as { block: string }).block === "other",
          ),
        ).toHaveLength(1)
      }),
    )
  })

  it("shows the session's trust as its view gives it, then as each TrustChanged says", async () => {
    const untrusted = { _tag: "Blocked", by: [{ _tag: "Untrusted" }] }
    const engine: Engine = { greet: task("greet", { status: untrusted, actions: [] }) }
    const main = fakeMain(answering(engine, { trust: { trusted: false, hash: HASH } }))
    await following(main, (next) =>
      Effect.gen(function* () {
        expect<unknown>((yield* next).trust).toEqual({ trusted: false, hash: HASH })
        engine.greet = task("greet")
        main.stream("Events", [
          event({ _tag: "TrustChanged", trust: { trusted: true, hash: HASH } }),
          event({ _tag: "BlockStatusChanged", block: "greet", status: { _tag: "Idle" } }),
        ])
        const trusted = yield* next
        expect<unknown>(trusted.trust).toEqual({ trusted: true, hash: HASH })
        expect(statusOf(trusted, "greet")).toBe("Idle")
      }),
    )
  })

  it("re-reads a block whose log grows, and shows the last page of a long log", async () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, n) => ({
        stream: "stdout" as const,
        text: `line ${n + 1}`,
      }))
    const engine: Engine = {
      greet: task("greet", {
        status: { _tag: "Running" },
        log: { offset: 0, total: 1, lines: lines(1) },
      }),
    }
    const main = fakeMain(answering(engine))
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).blocks.get("greet")?.log?.lines).toEqual(lines(1))
        engine.greet = { ...engine.greet, log: { offset: 0, total: 500, lines: lines(500) } }
        main.stream("Events", [
          event({
            _tag: "LogLines",
            block: "greet",
            run: "r-1",
            offset: 1,
            lines: lines(500).slice(1),
          }),
        ])
        const log = (yield* next).blocks.get("greet")?.log
        expect(log?.offset).toBe(300)
        expect(log?.lines.at(-1)).toEqual({ stream: "stdout", text: "line 500" })
      }),
    )
  })

  it("takes the session's events only a bounded way ahead of a read that waits, so main's stream waits on the acks", async () => {
    const engine: Engine = { greet: task("greet", { status: { _tag: "Running" } }) }
    let readsAnswer = true
    const main = fakeMain((tag, payload) =>
      // Once the follower is reading, a block's read waits, as a slow engine's does.
      !readsAnswer && tag === "GetBlock" ? undefined : answering(engine)(tag, payload),
    )
    const logLine = (offset: number) =>
      event({
        _tag: "LogLines",
        block: "greet",
        run: "r-1",
        offset,
        lines: [{ stream: "stdout", text: `line ${offset + 1}` }],
      })
    // Each chunk here is one event, and each place an event can wait takes all
    // the one before it holds: the client's buffer (effect's default, 16), the
    // piece taken from it, the window's queue, the piece the merge holds, and
    // the batch being read.
    const CLIENT_BUFFER = 16
    const MOST_HELD = 2 * CLIENT_BUFFER + 3 * EVENTS_AHEAD
    // Twice what the window can hold, so a window that holds more is seen.
    const SENT = 2 * MOST_HELD
    await following(main, (next) =>
      Effect.gen(function* () {
        yield* next
        readsAnswer = false
        // The first chunk starts a round of reads that waits; the rest arrive meanwhile.
        for (let offset = 0; offset < SENT; offset++) main.stream("Events", [logLine(offset)])
        expect(yield* steady(() => main.acked("Events"))).toBeLessThanOrEqual(MOST_HELD)
      }),
    )
  })

  it("re-reads a block whose files changed on disk, and shows what its view says of them", async () => {
    const engine: Engine = { greet: task("greet"), other: task("other") }
    const main = fakeMain(answering(engine))
    const onDisk = {
      hash: HASH,
      files: [
        {
          _tag: "Changed",
          path: "greet.sh",
          change: "modified",
          hunks: [
            {
              heldLine: 2,
              diskLine: 2,
              lines: [
                { kind: "deletion", text: "echo script-before" },
                { kind: "addition", text: "echo script-after" },
              ],
            },
          ],
        },
      ],
    }
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).blocks.get("greet")?.filesOnDisk).toBeUndefined()
        engine.greet = task("greet", { filesOnDisk: onDisk })
        main.stream("Events", [event({ _tag: "FilesOnDiskChanged", block: "greet" })])
        const changed = yield* next
        expect(changed.ended).toBeUndefined()
        expect<unknown>(changed.blocks.get("greet")?.filesOnDisk).toEqual(onDisk)
        const reads = main.asked.filter(({ tag }) => tag === "GetBlock")
        expect(reads.map(({ payload }) => (payload as { block: string }).block)).toEqual([
          "greet",
          "other",
          "greet",
        ])
      }),
    )
  })

  describe("each block's instruction", () => {
    /** A task whose instruction reads the form `config`, and a task with none. */
    const instructed = (): Engine => ({
      deploy: task("deploy", { instruction: code("echo us-east-1") }),
      config: { ...task("config"), tag: "Survey", class: "form" },
      build: task("build"),
    })

    it("is read again in instruction mode when a value or an output it may read changes", async () => {
      const engine = instructed()
      const main = fakeMain(answering(engine))
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            expect((yield* next).instructionMode).toBe(true)
            engine.deploy = { ...engine.deploy, instruction: code("echo eu-west-1") }
            main.stream("Events", [event({ _tag: "FieldsChanged", block: "config", fields: [] })])
            const changed = yield* next
            expect(changed.blocks.get("deploy")?.instruction).toEqual(code("echo eu-west-1"))
            engine.deploy = { ...engine.deploy, instruction: code("echo ap-south-1") }
            main.stream("Events", [event({ _tag: "OutputsWithdrawn", block: "build" })])
            expect((yield* next).blocks.get("deploy")?.instruction).toEqual(code("echo ap-south-1"))
            // The start's reads, then the value's, then the output's.
            expect(blocksRead(main)).toEqual([
              "deploy",
              "config",
              "build",
              "config",
              "deploy",
              "build",
              "deploy",
            ])
          }),
        { settings: makeSettingsStore(settingsWith(true)) },
      )
    })

    it("is not read out of instruction mode: a value or an output change reads only the blocks it names", async () => {
      const main = fakeMain(answering(instructed()))
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            expect((yield* next).instructionMode).toBe(false)
            main.stream("Events", [
              event({ _tag: "FieldsChanged", block: "config", fields: [] }),
              event({ _tag: "OutputsWithdrawn", block: "build" }),
            ])
            expect((yield* next).instructionMode).toBe(false)
            expect(blocksRead(main)).toEqual(["deploy", "config", "build", "config", "build"])
          }),
        { settings: makeSettingsStore(settingsWith(false)) },
      )
    })

    it("is read again when instruction mode turns on, before the window shows the mode", async () => {
      const engine = instructed()
      const main = fakeMain(answering(engine))
      const settings = makeSettingsStore(settingsWith(false))
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            yield* next
            // Out of the mode, the window keeps deploy's instruction as it read it.
            engine.deploy = { ...engine.deploy, instruction: code("echo eu-west-1") }
            main.stream("Events", [event({ _tag: "FieldsChanged", block: "config", fields: [] })])
            expect((yield* next).blocks.get("deploy")?.instruction).toEqual(code("echo us-east-1"))
            settings.set(settingsWith(true))
            const on = yield* next
            expect(on.instructionMode).toBe(true)
            expect(on.blocks.get("deploy")?.instruction).toEqual(code("echo eu-west-1"))
            expect(blocksRead(main)).toEqual(["deploy", "config", "build", "config", "deploy"])
          }),
        { settings },
      )
    })

    it("is not read when instruction mode turns off", async () => {
      const main = fakeMain(answering(instructed()))
      const settings = makeSettingsStore(settingsWith(true))
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            yield* next
            settings.set(settingsWith(false))
            expect((yield* next).instructionMode).toBe(false)
            expect(blocksRead(main)).toEqual(["deploy", "config", "build"])
          }),
        { settings },
      )
    })

    it("is read again when instruction mode turns on while the window reads the session at the start", async () => {
      const engine = instructed()
      const settings = makeSettingsStore(settingsWith(false))
      const main = fakeMain((tag, payload) => {
        if (tag === "GetSession") settings.set(settingsWith(true))
        return answering(engine)(tag, payload)
      })
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            expect((yield* next).instructionMode).toBe(false)
            expect((yield* next).instructionMode).toBe(true)
            expect(blocksRead(main)).toEqual(["deploy", "config", "build", "deploy"])
          }),
        { settings },
      )
    })

    it("still says the session closed when instruction mode turns on after it closed", async () => {
      const main = fakeMain(answering(instructed()))
      const settings = makeSettingsStore(settingsWith(false))
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            yield* next
            main.stream("Events", [event({ _tag: "SessionClosed" })])
            expect((yield* next).ended).toBe(
              "This runbook's session closed, so the window shows it as it was left.",
            )
            settings.set(settingsWith(true))
            const on = yield* next
            expect(on.instructionMode).toBe(true)
            expect(on.ended).toBe(
              "This runbook's session closed, so the window shows it as it was left.",
            )
          }),
        { settings },
      )
    })

    it("ends in the mode the settings last give, however many changes come while it reads", async () => {
      const engine = instructed()
      const settings = makeSettingsStore(settingsWith(false))
      let flipping = false
      const main = fakeMain((tag, payload) => {
        // While the window reads for the mode turning on, the person turns it off and on again.
        if (flipping && tag === "GetBlock") {
          flipping = false
          settings.set(settingsWith(false))
          settings.set(settingsWith(true))
        }
        return answering(engine)(tag, payload)
      })
      let latest: Live | undefined
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            yield* next
            flipping = true
            settings.set(settingsWith(true))
            yield* Effect.sleep("100 millis")
            expect(latest?.instructionMode).toBe(true)
          }),
        { settings, shown: (live) => (latest = live) },
      )
    })

    it("stops listening to the settings once the window stops following", async () => {
      const store = makeSettingsStore(settingsWith(false))
      let listening = 0
      const settings: SettingsStore = {
        get: store.get,
        subscribe: (listener) => {
          listening++
          const stop = store.subscribe(listener)
          return () => {
            listening--
            stop()
          }
        },
      }
      const main = fakeMain(answering(instructed()))
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            yield* next
            expect(listening).toBe(1)
          }),
        { settings },
      )
      expect(listening).toBe(0)
    })

    it("is not read, and nothing is shown again, when a setting other than the mode changes", async () => {
      const engine = instructed()
      const main = fakeMain(answering(engine))
      const settings = makeSettingsStore(settingsWith(true))
      await following(
        main,
        (next) =>
          Effect.gen(function* () {
            yield* next
            settings.set(settingsWith(true, { theme: "dark" }))
            engine.build = task("build", { status: { _tag: "Running" }, actions: ["cancel"] })
            main.stream("Events", [
              event({ _tag: "BlockStatusChanged", block: "build", status: { _tag: "Running" } }),
            ])
            // The next state shown is the event's.
            expect(statusOf(yield* next, "build")).toBe("Running")
            expect(blocksRead(main)).toEqual(["deploy", "config", "build", "build"])
          }),
        { settings },
      )
    })
  })

  it("draws the runbook the session holds once it reloads it: a block it no longer has goes, one it added is read, and one it kept is read again", async () => {
    const engine: Engine = {
      greet: task("greet", { instruction: [{ kind: "code", language: "bash", code: "echo hi" }] }),
      later: task("later"),
    }
    let held = documentOf(HASH, "Before", ["greet", "later"])
    const main = fakeMain((tag, payload) =>
      tag === "GetDocument" ? held : answering(engine)(tag, payload),
    )
    await following(main, (next) =>
      Effect.gen(function* () {
        const before = yield* next
        expect(before.document).toBe(OPENED)
        expect([...before.blocks.keys()].sort()).toEqual(["greet", "later"])
        // The reload keeps greet, whose instruction reads a prop that changed, drops later and adds added.
        delete engine.later
        engine.greet = task("greet", {
          instruction: [{ kind: "code", language: "bash", code: "echo hello" }],
        })
        engine.added = task("added")
        held = documentOf(RELOADED, "After", ["greet", "added"])
        main.stream("Events", [
          event({ _tag: "DocumentChanged", hash: RELOADED }),
          event({ _tag: "TrustChanged", trust: { trusted: true, hash: RELOADED } }),
          event({ _tag: "BlockStatusChanged", block: "added", status: { _tag: "Idle" } }),
        ])
        const after = yield* next
        expect(after.ended).toBeUndefined()
        expect<unknown>(after.document?.hash).toBe(RELOADED)
        expect<unknown>(after.document?.blocks.map((block) => block.id)).toEqual(["greet", "added"])
        expect([...after.blocks.keys()].sort()).toEqual(["added", "greet"])
        expect(after.blocks.get("greet")?.instruction).toEqual([
          { kind: "code", language: "bash", code: "echo hello" },
        ])
        expect<unknown>(after.trust).toEqual({ trusted: true, hash: RELOADED })
      }),
    )
  })

  it("reads the runbook again at the start when the session reloaded it after the window read it", async () => {
    // A reload between the window's read and the session's view logs no event after the view.
    const main = fakeMain((tag, payload) =>
      tag === "GetDocument"
        ? documentOf(RELOADED, "After", ["greet"])
        : answering({ greet: task("greet") }, { trust: { trusted: false, hash: RELOADED } })(
            tag,
            payload,
          ),
    )
    await following(main, (next) =>
      Effect.gen(function* () {
        expect<unknown>((yield* next).document?.hash).toBe(RELOADED)
      }),
    )
  })

  it("reads the runbook only once, the window's own read, when the session still holds it", async () => {
    const main = fakeMain(answering({ greet: task("greet") }))
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).document).toBe(OPENED)
        expect(main.asked.filter(({ tag }) => tag === "GetDocument")).toEqual([])
      }),
    )
  })

  it("shows why the session holds back a reload as its view gives it, then as each ReloadHeldChanged says, until one clears it", async () => {
    const running = { _tag: "Running", blocks: ["greet"] }
    const main = fakeMain(answering({ greet: task("greet") }, { reloadHeld: running }))
    const unreadable = {
      _tag: "Unreadable",
      message: "There is no file at /runbooks/deploy/runbook.mdx.",
    }
    await following(main, (next) =>
      Effect.gen(function* () {
        expect<unknown>((yield* next).reloadHeld).toEqual(running)
        main.stream("Events", [event({ _tag: "ReloadHeldChanged", held: unreadable })])
        expect<unknown>((yield* next).reloadHeld).toEqual(unreadable)
        // An event that says nothing of it keeps it.
        main.stream("Events", [
          event({ _tag: "TrustChanged", trust: { trusted: true, hash: HASH } }),
        ])
        expect<unknown>((yield* next).reloadHeld).toEqual(unreadable)
        main.stream("Events", [event({ _tag: "ReloadHeldChanged" })])
        expect((yield* next).reloadHeld).toBeUndefined()
      }),
    )
  })

  it("shows that the session stopped watching, as its view or an Unwatched says", async () => {
    const message =
      "Runbooks could not watch /runbooks/deploy/runbook.mdx, or the files it names, for changes."
    const fromView = fakeMain(answering({ greet: task("greet") }, { unwatched: { message } }))
    await following(fromView, (next) =>
      Effect.gen(function* () {
        expect((yield* next).unwatched).toEqual({ message })
      }),
    )
    const fromEvent = fakeMain(answering({ greet: task("greet") }))
    await following(fromEvent, (next) =>
      Effect.gen(function* () {
        expect((yield* next).unwatched).toBeUndefined()
        fromEvent.stream("Events", [event({ _tag: "Unwatched", message })])
        expect((yield* next).unwatched).toEqual({ message })
        fromEvent.stream("Events", [
          event({ _tag: "TrustChanged", trust: { trusted: true, hash: HASH } }),
        ])
        expect((yield* next).unwatched).toEqual({ message })
      }),
    )
  })

  it("says when the session closes", async () => {
    const main = fakeMain(answering({ greet: task("greet") }))
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).ended).toBeUndefined()
        main.stream("Events", [event({ _tag: "SessionClosed" })])
        expect((yield* next).ended).toBe(
          "This runbook's session closed, so the window shows it as it was left.",
        )
      }),
    )
  })

  it("says the session ended when its events end, though no event said it closed", async () => {
    const main = fakeMain(answering({ greet: task("greet") }))
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).ended).toBeUndefined()
        main.end("Events")
        expect((yield* next).ended).toBe(
          "This runbook's session closed, so the window shows it as it was left.",
        )
      }),
    )
  })

  it("says the engine failed when a read dies, rather than showing the session stale", async () => {
    const main = fakeMain((tag, payload) =>
      tag === "GetBlock"
        ? dies({ name: "RangeError", message: "Maximum call stack size exceeded" })
        : answering({ greet: task("greet") })(tag, payload),
    )
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).ended).toBe(
          "The engine failed, so the window stopped following this runbook: Maximum call stack size exceeded",
        )
      }),
    )
  })

  it("drops a block the engine no longer has when it reads it, as after a reload that removed it, and keeps following", async () => {
    const engine: Engine = { greet: task("greet"), other: task("other") }
    let removed = false
    const main = fakeMain((tag, payload) =>
      removed && tag === "GetBlock" && (payload as { block: string }).block === "greet"
        ? fails({ _tag: "UnknownBlock", session: SESSION, block: "greet" })
        : answering(engine)(tag, payload),
    )
    await following(main, (next) =>
      Effect.gen(function* () {
        expect([...(yield* next).blocks.keys()].sort()).toEqual(["greet", "other"])
        // greet is done, and the reload it held back removes it before the window reads it.
        removed = true
        main.stream("Events", [
          event({
            _tag: "BlockStatusChanged",
            block: "greet",
            status: { _tag: "Done", outcome: "success" },
          }),
        ])
        const dropped = yield* next
        expect(dropped.ended).toBeUndefined()
        expect([...dropped.blocks.keys()]).toEqual(["other"])
        engine.other = task("other", { status: { _tag: "Running" }, actions: ["cancel"] })
        main.stream("Events", [
          event({ _tag: "BlockStatusChanged", block: "other", status: { _tag: "Running" } }),
        ])
        expect(statusOf(yield* next, "other")).toBe("Running")
      }),
    )
  })

  it("says the engine has logged no such event, when it can't start after the view's", async () => {
    const main = fakeMain(answering({ greet: task("greet") }))
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).ended).toBeUndefined()
        main.end("Events", fails({ _tag: "UnknownSequence", session: SESSION, after: 4, next: 2 }))
        expect((yield* next).ended).toBe(
          "The engine has logged no event 4 in this runbook's session, so the window stopped following it.",
        )
      }),
    )
  })

  it("says the engine did not answer when the bridge refuses a read", async () => {
    const main = fakeMain(answering({ greet: task("greet") }))
    const refusing: FakeMain = {
      ...main,
      bridge: {
        ...main.bridge,
        send: (text) => {
          if (text.includes('"tag":"GetBlock"')) throw new Error("over the bridge's cap")
          main.bridge.send(text)
        },
      },
    }
    await following(refusing, (next) =>
      Effect.gen(function* () {
        expect((yield* next).ended).toBe(
          "The engine did not answer, so the window stopped following this runbook: The engine bridge refused the message.",
        )
      }),
    )
  })

  it("says what failed when the engine can't give the session, instead of showing it stale", async () => {
    const main = fakeMain((tag) =>
      tag === "GetSession" ? fails({ _tag: "UnknownSession", session: SESSION }) : undefined,
    )
    await following(main, (next) =>
      Effect.gen(function* () {
        expect((yield* next).ended).toBe(
          "This runbook's session closed, so the window shows it as it was left.",
        )
      }),
    )
  })
})
