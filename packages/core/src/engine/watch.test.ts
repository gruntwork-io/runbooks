/**
 * The session's watcher (`watcher.ts`), through the engine, on the test
 * clock: what each watch mode watches, the notice a named file's save
 * gives, the reload a runbook's save gives, and the debounce between.
 */
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Layer, Logger, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  BlockId,
  defineTask,
  type TaskError,
  type TaskEvent,
  type TaskInput,
} from "@runbooks/blocks-core/contract"
import { FileWatchError } from "../errors/index.ts"
import { FileSystem, type FileSystemShape } from "../services/FileSystem.ts"
import { testCredentialProviders } from "../test-utils/TestCredentialProviders.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import { Caller, type EventEnvelope, type Origin, type WatchMode } from "./protocol.ts"
import { WATCH_DEBOUNCE } from "./watcher.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

type Script = (input: TaskInput) => Stream.Stream<TaskEvent<string>, TaskError>

/** Outputs the text of `file` as the session gave it to the run. */
const printsFile =
  (file: string): Script =>
  (input) =>
    Stream.make({ _tag: "Output", key: "out", value: input.files.get(file) ?? "(none)" })

/** Holds a run open: `taken` completes once the run has started; the run ends when `open` does. */
const gate = () => {
  const taken = Deferred.makeUnsafe<void>()
  const open = Deferred.makeUnsafe<void>()
  const script: Script = () =>
    Stream.fromEffectDrain(Effect.andThen(Deferred.succeed(taken, undefined), Deferred.await(open)))
  return { taken, open, script }
}

const registryWith = (more: Readonly<Record<string, Script>>) => {
  const scripts: Readonly<Record<string, Script>> = { deploy: printsFile("deploy.sh"), ...more }
  return {
    ...TOY_REGISTRY,
    Run: defineTask({
      ...TOY_REGISTRY.Run,
      run: (p, input) => scripts[p.command ?? ""]?.(input) ?? Stream.empty,
    }),
  }
}

const runbookOf = (...blocks: ReadonlyArray<string>) => blocks.join("\n\n")

/** A file in the runbook's folder, one in a folder below it, and a folder. */
const RUNBOOK_TEXT = runbookOf(
  '<Run id="deploy" command="deploy" path="deploy.sh" outputs={["out"]} />',
  '<Run id="nested" path="scripts/nested.sh" outputs={["out"]} />',
  '<Run id="folder" path="templates" outputs={["out"]} />',
)
const FILES = {
  "/rb/deploy.sh": "echo deploy\n",
  "/rb/scripts/nested.sh": "echo nested\n",
  "/rb/templates/a.txt": "a\n",
}
const FOLDERS = ["/rb", "/rb/scripts", "/rb/templates", "/rb/lib"]

/** What the session's watcher asked the file system to watch, and how many of its watches are open. */
interface Watching {
  readonly calls: Array<{ readonly paths: ReadonlyArray<string>; readonly depth?: number }>
  open: number
  /** How many times the runbook was read: once to open it, and once for each reload. */
  runbookReads: number
  /** Each file read whole, as a block's named file is, by absolute path, in order. */
  readonly reads: Array<string>
  /** Once set, each read of `path` waits for `until`, as a slow disk's would. */
  slowRead?: { readonly path: string; readonly until: Deferred.Deferred<void> }
}

interface Options {
  readonly watch?: WatchMode
  readonly origin?: Origin
  /** Each watch fails as it starts, as one past the OS's limit on watches does. */
  readonly watchFails?: boolean
  /** Each event names its file as a file system that ignores case spells it on disk. */
  readonly onDiskCase?: boolean
  /** The runbook, and the files in its folder, in place of `RUNBOOK_TEXT` and `FILES`. */
  readonly runbook?: string
  readonly files?: Readonly<Record<string, string>>
  /** More scripts a `<Run>` names in its `command`. */
  readonly scripts?: Readonly<Record<string, Script>>
}

/** Runs `program` against an engine on the test clock, and gives what it returned, watched and logged. */
const withWatch = async <A, E>(
  program:
    | Effect.Effect<A, E, Engine | Caller | FileSystem>
    | ((watching: Watching) => Effect.Effect<A, E, Engine | Caller | FileSystem>),
  {
    watchFails = false,
    onDiskCase = false,
    origin = "person",
    runbook = RUNBOOK_TEXT,
    files: initial = FILES,
    scripts = {},
  }: Options = {},
) => {
  const inner = testFileSystem({ [RUNBOOK]: runbook, ...initial }, FOLDERS)
  const watching: Watching = { calls: [], open: 0, runbookReads: 0, reads: [] }
  const warnings: string[] = []
  const files: FileSystemShape = {
    ...inner,
    readFile: (file) => {
      if (file === RUNBOOK) watching.runbookReads += 1
      return inner.readFile(file)
    },
    readFileBuffer: (file) => {
      watching.reads.push(file)
      const slow = watching.slowRead
      return slow?.path === file
        ? Effect.andThen(Deferred.await(slow.until), inner.readFileBuffer(file))
        : inner.readFileBuffer(file)
    },
    watch: (paths, options) => {
      watching.calls.push({
        paths: [...paths],
        ...(options?.depth === undefined ? {} : { depth: options.depth }),
      })
      if (watchFails) return Stream.fail(new FileWatchError({ cause: "ENOSPC" }))
      return Stream.unwrap(
        Effect.sync(() => {
          watching.open += 1
          return inner.watch(paths, options).pipe(
            Stream.map((event) =>
              onDiskCase
                ? {
                    ...event,
                    path: path.join(
                      path.dirname(event.path),
                      path.basename(event.path).toUpperCase(),
                    ),
                  }
                : event,
            ),
            Stream.ensuring(Effect.sync(() => (watching.open -= 1))),
          )
        }),
      )
    },
  }
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn")
      warnings.push(Array.isArray(message) ? message.join(" ") : String(message))
  })
  const result = await Effect.runPromise(
    (typeof program === "function" ? program(watching) : program).pipe(
      Effect.provide(
        Engine.layer({
          registry: registryWith(scripts),
          appVersion: "0.31.0",
          workingFolders: "/work",
          stateFolders: "/state",
          processEnvironment: {},
        }),
      ),
      Effect.provide(testCredentialProviders({}, [])),
      Effect.provide(testSettingsStore()),
      Effect.provide(testSessionStore()),
      Effect.provide(Layer.succeed(FileSystem, files)),
      Effect.provideService(Caller, { origin }),
      Effect.provide(Logger.layer([logger])),
      Effect.provide(TestClock.layer()),
    ),
  )
  return { result, watching, warnings }
}

/** Lets every fiber the last step woke run until it waits. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
})

/** Moves the test clock on by `millis`, letting what it wakes run. */
const tick = (millis: number) =>
  Effect.andThen(settle, Effect.andThen(TestClock.adjust(millis), settle))

/** Opens the runbook in `watch` mode, and gives the commands a test sends its session. */
const opened = (watch: WatchMode | undefined) =>
  Effect.gen(function* () {
    const engine = yield* Engine
    const files = yield* FileSystem
    const result = yield* engine.openSession({
      path: RUNBOOK,
      ...(watch === undefined ? {} : { watch }),
    })
    if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join("\n"))
    const { session } = result.session
    const target = (block: string) => ({ session, block: blockId(block) })
    const recording = yield* Effect.forkChild(Stream.runCollect(engine.events({ session })))
    yield* settle
    return {
      view: result.session,
      trust: Effect.flatMap(engine.getSession({ session }), (view) =>
        engine.trustSession({ session, hash: view.trust.hash }),
      ),
      start: (block: string) => engine.runBlock(target(block)),
      run: (block: string) =>
        Effect.andThen(
          engine.runBlock(target(block)),
          engine.waitForBlock({ ...target(block), timeoutMillis: 5000 }),
        ),
      block: (block: string) => engine.getBlock(target(block)),
      session: engine.getSession({ session }),
      document: engine.getDocument({ session }),
      /** Saves `text` at `file`, as an editor would. */
      write: (file: string, text: string) => files.writeFile(file, text),
      remove: (file: string) => files.rm(file),
      close: engine.closeSession({ session }),
      /** The tags of every event logged, once `close` has run. */
      logged: Effect.map(Fiber.join(recording), (events: ReadonlyArray<EventEnvelope>) =>
        events.map(({ event }) => ("block" in event ? `${event._tag} ${event.block}` : event._tag)),
      ),
    }
  })

/** What the block's latest run was given of the file it names. */
const ranWith = (view: { readonly outputs: Readonly<Record<string, unknown>> }) =>
  view.outputs["out"]

const DEBOUNCE = 300

describe("a session's watcher", () => {
  it("waits the old app's 300 ms for a burst of saves to end", () => {
    expect(Duration.toMillis(WATCH_DEBOUNCE)).toBe(DEBOUNCE)
  })

  it("watches nothing when the session is opened with no watch mode, or `off`", async () => {
    for (const watch of [undefined, "off"] as const) {
      const { result, watching } = await withWatch(
        Effect.gen(function* () {
          const rb = yield* opened(watch)
          yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
          yield* tick(DEBOUNCE)
          return (yield* rb.block("deploy")).filesOnDisk
        }),
      )
      expect(result).toBeUndefined()
      expect(watching.calls).toEqual([])
    }
  })

  it("watches the runbook's folder and each named file's folder at depth 0, and each named folder whole", async () => {
    const { watching } = await withWatch(opened("notice"))
    expect(watching.calls).toEqual([
      { paths: ["/rb", "/rb/scripts"], depth: 0 },
      { paths: ["/rb/templates"] },
    ])
  })

  it("in `notice`, shows each named file saved once a burst of saves ends, and never reloads", async () => {
    const { result, watching } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("notice")
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        yield* tick(DEBOUNCE - 1)
        const early = (yield* rb.block("deploy")).filesOnDisk
        // Saved again within the window: it starts again.
        yield* rb.write("/rb/deploy.sh", "echo deploy v3\n")
        yield* rb.write("/rb/scripts/nested.sh", "echo nested v2\n")
        yield* rb.write("/rb/templates/b.txt", "b\n")
        yield* rb.write(RUNBOOK, `${RUNBOOK_TEXT}\n\nSaved.`)
        yield* tick(DEBOUNCE - 1)
        const later = (yield* rb.block("deploy")).filesOnDisk
        yield* tick(1)
        const deploy = (yield* rb.block("deploy")).filesOnDisk
        const nested = (yield* rb.block("nested")).filesOnDisk
        const folder = (yield* rb.block("folder")).filesOnDisk
        yield* rb.remove("/rb/deploy.sh")
        yield* tick(DEBOUNCE)
        const removed = (yield* rb.block("deploy")).filesOnDisk
        const { reloadHeld } = yield* rb.session
        const { hash } = yield* rb.document
        yield* rb.close
        return {
          early,
          later,
          deploy,
          nested,
          folder,
          removed,
          reloadHeld,
          reloaded: hash !== rb.view.trust.hash,
          logged: yield* rb.logged,
        }
      }),
    )
    expect([result.early, result.later]).toEqual([undefined, undefined])
    expect(result.deploy?.files).toMatchObject([
      {
        path: "deploy.sh",
        change: "modified",
        hunks: [{ lines: [{ kind: "deletion" }, { kind: "addition", text: "echo deploy v3" }] }],
      },
    ])
    expect(result.nested?.files).toMatchObject([{ path: "scripts/nested.sh", change: "modified" }])
    expect(result.folder?.files).toMatchObject([{ path: "templates/b.txt", change: "created" }])
    expect(result.removed?.files).toMatchObject([{ path: "deploy.sh", change: "deleted" }])
    expect([result.reloadHeld, result.reloaded]).toEqual([undefined, false])
    expect(result.logged.filter((tag) => tag.startsWith("FilesOnDisk"))).toEqual([
      "FilesOnDiskChanged deploy",
      "FilesOnDiskChanged nested",
      "FilesOnDiskChanged folder",
      "FilesOnDiskChanged deploy",
    ])
    expect(result.logged).not.toContain("DocumentChanged")
    expect(watching.runbookReads).toBe(1)
  })

  it("in `notice`, holds no notice back for saves of the runbook, which it doesn't reload", async () => {
    const { result } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("notice")
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        // The runbook saved every 200 ms from then on.
        yield* tick(200)
        yield* rb.write(RUNBOOK, `${RUNBOOK_TEXT}\n\nSaved at 200.`)
        yield* tick(DEBOUNCE - 200 - 1)
        const early = (yield* rb.block("deploy")).filesOnDisk
        yield* tick(1)
        const shown = (yield* rb.block("deploy")).filesOnDisk
        for (const at of [400, 600, 800]) {
          yield* tick(at === 400 ? 100 : 200)
          yield* rb.write(RUNBOOK, `${RUNBOOK_TEXT}\n\nSaved at ${at}.`)
        }
        yield* tick(DEBOUNCE)
        return { early, shown }
      }),
    )
    expect(result.early).toBeUndefined()
    expect(result.shown?.files).toMatchObject([{ path: "deploy.sh", change: "modified" }])
  })

  it("holds no notice back for a save in a watched folder of a file the runbook doesn't name", async () => {
    const { result } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("notice")
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        yield* tick(DEBOUNCE - 100)
        yield* rb.write("/rb/notes.txt", "not named\n")
        yield* tick(100)
        return (yield* rb.block("deploy")).filesOnDisk
      }),
    )
    expect(result?.files).toMatchObject([{ path: "deploy.sh", change: "modified" }])
  })

  it("in `runbook`, reloads on a save of the runbook with each named file at the text the session holds, and shows it on disk", async () => {
    const { result, watching } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("runbook")
        yield* rb.trust
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        yield* rb.write(RUNBOOK, `${RUNBOOK_TEXT}\n\nSaved.`)
        yield* tick(DEBOUNCE)
        const reloaded = (yield* rb.document).hash !== rb.view.trust.hash
        const ran = ranWith((yield* rb.run("deploy")).block)
        const deploy = (yield* rb.block("deploy")).filesOnDisk
        // A named file's save alone gives the notice, never a reload.
        yield* rb.write("/rb/scripts/nested.sh", "echo nested v2\n")
        yield* tick(DEBOUNCE)
        const nested = (yield* rb.block("nested")).filesOnDisk
        yield* rb.close
        return { reloaded, ran, deploy, nested, logged: yield* rb.logged }
      }),
    )
    expect(result.reloaded).toBe(true)
    expect(result.ran).toEqual({ _tag: "Shown", value: "echo deploy\n" })
    expect(result.deploy?.files).toMatchObject([{ path: "deploy.sh", change: "modified" }])
    expect(result.nested?.files).toMatchObject([{ path: "scripts/nested.sh" }])
    expect(result.logged.filter((tag) => tag === "DocumentChanged")).toHaveLength(1)
    // Opened, and reloaded once; and watched once, as the reload names what it did.
    expect(watching.runbookReads).toBe(2)
    expect(watching.calls).toHaveLength(2)
  })

  it("in `runbookAndFiles`, reloads on a save of the runbook reading each named file again", async () => {
    const { result, watching } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("runbookAndFiles")
        yield* rb.trust
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        yield* rb.write(RUNBOOK, `${RUNBOOK_TEXT}\n\nSaved.`)
        yield* tick(DEBOUNCE)
        const ran = ranWith((yield* rb.run("deploy")).block)
        const deploy = (yield* rb.block("deploy")).filesOnDisk
        yield* rb.write("/rb/scripts/nested.sh", "echo nested v2\n")
        yield* tick(DEBOUNCE)
        const nested = (yield* rb.block("nested")).filesOnDisk
        yield* rb.close
        return { ran, deploy, nested, logged: yield* rb.logged }
      }),
    )
    expect(result.ran).toEqual({ _tag: "Shown", value: "echo deploy v2\n" })
    expect(result.deploy).toBeUndefined()
    expect(result.nested?.files).toMatchObject([{ path: "scripts/nested.sh" }])
    expect(result.logged.filter((tag) => tag === "DocumentChanged")).toHaveLength(1)
    expect(watching.runbookReads).toBe(2)
  })

  it("shows a named file saved with a runbook the session refuses, and holds the runbook back", async () => {
    const { result } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("runbookAndFiles")
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        yield* rb.write(RUNBOOK, '<Run id="broken"')
        yield* tick(DEBOUNCE)
        return {
          deploy: (yield* rb.block("deploy")).filesOnDisk,
          held: (yield* rb.session).reloadHeld?._tag,
        }
      }),
    )
    expect(result.deploy?.files).toMatchObject([{ path: "deploy.sh", change: "modified" }])
    expect(result.held).toBe("Invalid")
  })

  it("watches again what a reloaded runbook names, and stops watching what it no longer names", async () => {
    const { result, watching } = await withWatch((watched) =>
      Effect.gen(function* () {
        const rb = yield* opened("runbookAndFiles")
        yield* rb.write("/rb/lib/added.sh", "echo added\n")
        yield* rb.write(
          RUNBOOK,
          runbookOf(
            '<Run id="deploy" command="deploy" path="deploy.sh" outputs={["out"]} />',
            '<Run id="added" path="lib/added.sh" outputs={["out"]} />',
          ),
        )
        yield* tick(DEBOUNCE)
        yield* rb.write("/rb/lib/added.sh", "echo added v2\n")
        yield* tick(DEBOUNCE)
        return { added: (yield* rb.block("added")).filesOnDisk, open: watched.open }
      }),
    )
    expect(result.added?.files).toMatchObject([{ path: "lib/added.sh", change: "modified" }])
    expect(watching.calls.slice(2)).toEqual([{ paths: ["/rb", "/rb/lib"], depth: 0 }])
    expect(result.open).toBe(1)
  })

  it("in `runbook`, watches what a reload names, and shows how each held file differs on disk", async () => {
    const { result, watching } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("runbook")
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        yield* rb.write("/rb/lib/added.sh", "echo added\n")
        yield* rb.write(
          RUNBOOK,
          runbookOf(
            '<Run id="deploy" command="deploy" path="deploy.sh" outputs={["out"]} />',
            '<Run id="added" path="lib/added.sh" />',
          ),
        )
        yield* tick(DEBOUNCE)
        return (yield* rb.block("deploy")).filesOnDisk
      }),
    )
    expect(result?.files).toMatchObject([{ path: "deploy.sh", change: "modified" }])
    expect(watching.calls.slice(2)).toEqual([{ paths: ["/rb", "/rb/lib"], depth: 0 }])
  })

  it("watches what a reload held back until a run ended names, and takes the saves it saw before", async () => {
    const held = gate()
    const text = runbookOf(
      '<Run id="deploy" command="deploy" path="deploy.sh" outputs={["out"]} />',
      '<Run id="wait" command="wait" />',
    )
    const { result, watching } = await withWatch(
      (watched) =>
        Effect.gen(function* () {
          const rb = yield* opened("runbook")
          yield* rb.trust
          yield* rb.start("wait")
          yield* Deferred.await(held.taken)
          yield* rb.write(RUNBOOK, runbookOf(text, '<Run id="added" path="lib/added.sh" />'))
          yield* tick(DEBOUNCE)
          const reloadHeld = (yield* rb.session).reloadHeld?._tag
          // Seen, and not yet taken, when the run ends and the session takes the reload.
          yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
          yield* tick(DEBOUNCE - 100)
          yield* Deferred.succeed(held.open, undefined)
          yield* settle
          const watchedAgain = watched.calls.slice(1)
          yield* tick(DEBOUNCE - 1)
          const early = (yield* rb.block("deploy")).filesOnDisk
          yield* tick(1)
          return {
            reloadHeld,
            watchedAgain,
            early,
            deploy: (yield* rb.block("deploy")).filesOnDisk,
          }
        }),
      {
        runbook: text,
        files: { "/rb/deploy.sh": "echo deploy\n", "/rb/lib/added.sh": "echo added\n" },
        scripts: { wait: held.script },
      },
    )
    expect(result.reloadHeld).toBe("Running")
    expect(result.watchedAgain).toEqual([{ paths: ["/rb", "/rb/lib"], depth: 0 }])
    expect(result.early).toBeUndefined()
    expect(result.deploy?.files).toMatchObject([{ path: "deploy.sh", change: "modified" }])
    expect(watching.calls).toHaveLength(2)
  })

  it("takes a batch whole before it watches what a reload taken meanwhile names", async () => {
    const held = gate()
    const until = Deferred.makeUnsafe<void>()
    const text = runbookOf(
      '<Run id="deploy" command="deploy" path="deploy.sh" outputs={["out"]} />',
      '<Run id="wait" command="wait" />',
    )
    const { result } = await withWatch(
      (watched) =>
        Effect.gen(function* () {
          const rb = yield* opened("runbook")
          yield* rb.trust
          yield* rb.start("wait")
          yield* Deferred.await(held.taken)
          yield* rb.write(RUNBOOK, runbookOf(text, '<Run id="added" path="lib/added.sh" />'))
          yield* tick(DEBOUNCE)
          // The watcher reads deploy.sh, slowly; the run ends, and the session takes the reload, meanwhile.
          watched.slowRead = { path: "/rb/deploy.sh", until }
          yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
          yield* tick(DEBOUNCE)
          yield* Deferred.succeed(held.open, undefined)
          yield* settle
          const reloadHeld = (yield* rb.session).reloadHeld
          yield* Deferred.succeed(until, undefined)
          yield* settle
          return {
            reloadHeld,
            deploy: (yield* rb.block("deploy")).filesOnDisk,
            watchedAgain: watched.calls.slice(1),
          }
        }),
      {
        runbook: text,
        files: { "/rb/deploy.sh": "echo deploy\n", "/rb/lib/added.sh": "echo added\n" },
        scripts: { wait: held.script },
      },
    )
    expect(result.reloadHeld).toBeUndefined()
    expect(result.deploy?.files).toMatchObject([{ path: "deploy.sh", change: "modified" }])
    expect(result.watchedAgain).toEqual([{ paths: ["/rb", "/rb/lib"], depth: 0 }])
  })

  it("matches a saved file as a file system that ignores case spells it", async () => {
    const named = '<Run id="deploy" path="Deploy.sh" />'
    const { result } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("runbookAndFiles")
        // Reported as /rb/DEPLOY.SH, and the runbook as /rb/RUNBOOK.MDX.
        yield* rb.write("/rb/Deploy.sh", "echo deploy v2\n")
        yield* tick(DEBOUNCE)
        const deploy = (yield* rb.block("deploy")).filesOnDisk
        yield* rb.write(RUNBOOK, `${named}\n\nSaved.`)
        yield* tick(DEBOUNCE)
        return { deploy, reloaded: (yield* rb.document).hash !== rb.view.trust.hash }
      }),
      { onDiskCase: true, runbook: named, files: { "/rb/Deploy.sh": "echo deploy\n" } },
    )
    expect(result.deploy?.files).toMatchObject([{ path: "Deploy.sh" }])
    expect(result.reloaded).toBe(true)
  })

  it("watches no folder outside the runbook's, for a path a block names there", async () => {
    const { watching } = await withWatch(opened("notice"), {
      runbook: '<Run id="outside" path="../outside.sh" />',
      files: { "/outside.sh": "echo outside\n" },
    })
    expect(watching.calls).toEqual([{ paths: ["/rb"], depth: 0 }])
  })

  it("watches the folder of a file a block names that is missing, so creating it gives the notice", async () => {
    const { result, watching } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("notice")
        yield* rb.write("/rb/lib/later.sh", "echo later\n")
        yield* tick(DEBOUNCE)
        return (yield* rb.block("later")).filesOnDisk
      }),
      { runbook: '<Run id="later" path="lib/later.sh" />', files: {} },
    )
    expect(watching.calls).toEqual([{ paths: ["/rb", "/rb/lib"], depth: 0 }])
    expect(result?.files).toMatchObject([{ path: "lib/later.sh", change: "created" }])
  })

  it("watches the runbook's folder for a runbook that names no file", async () => {
    const { result, watching } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("runbookAndFiles")
        yield* rb.write(RUNBOOK, "# Deploy\n\nSaved.")
        yield* tick(DEBOUNCE)
        return (yield* rb.document).hash !== rb.view.trust.hash
      }),
      { runbook: "# Deploy", files: {} },
    )
    expect(watching.calls).toEqual([{ paths: ["/rb"], depth: 0 }])
    expect(result).toBe(true)
  })

  it("reads again only the files saved since it last read", async () => {
    const { watching } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("notice")
        yield* rb.write("/rb/deploy.sh", "echo deploy v2\n")
        yield* tick(DEBOUNCE)
        yield* rb.write("/rb/scripts/nested.sh", "echo nested v2\n")
        yield* tick(DEBOUNCE)
      }),
    )
    expect(watching.reads).toEqual([
      // To open the runbook.
      "/rb/deploy.sh",
      "/rb/scripts/nested.sh",
      "/rb/templates/a.txt",
      "/rb/deploy.sh",
      "/rb/scripts/nested.sh",
    ])
  })

  it("closes its watches when the session closes", async () => {
    const { result, watching } = await withWatch((watched) =>
      Effect.gen(function* () {
        const rb = yield* opened("notice")
        const open = watched.open
        yield* rb.close
        yield* settle
        return open
      }),
    )
    expect(result).toBe(2)
    expect(watching.calls).toHaveLength(2)
    expect(watching.open).toBe(0)
  })

  it("keeps the mode a session was opened in when its runbook is opened again in another", async () => {
    const { result } = await withWatch(
      Effect.gen(function* () {
        const kept = yield* opened("notice")
        const other = yield* opened("runbookAndFiles")
        yield* kept.write(RUNBOOK, `${RUNBOOK_TEXT}\n\nSaved.`)
        yield* tick(DEBOUNCE)
        return {
          kept: (yield* kept.document).hash !== kept.view.trust.hash,
          other: (yield* other.document).hash !== other.view.trust.hash,
          sessions: (yield* (yield* Engine).listSessions).length,
        }
      }),
    )
    expect(result).toEqual({ kept: false, other: true, sessions: 2 })
  })

  it("watches for an agent that opens the runbook in `notice`", async () => {
    const { watching } = await withWatch(opened("notice"), { origin: "agent" })
    expect(watching.calls).toHaveLength(2)
  })

  it("logs a watch that fails, and holds nothing back", async () => {
    const { result, warnings } = await withWatch(
      Effect.gen(function* () {
        const rb = yield* opened("runbookAndFiles")
        yield* rb.write(RUNBOOK, `${RUNBOOK_TEXT}\n\nSaved.`)
        yield* tick(DEBOUNCE)
        const view = yield* rb.session
        return { reloadHeld: view.reloadHeld, reloaded: view.trust.hash !== rb.view.trust.hash }
      }),
      { watchFails: true },
    )
    expect(result).toEqual({ reloadHeld: undefined, reloaded: false })
    expect(warnings).toEqual([expect.stringContaining("could not watch")])
    expect(warnings[0]).toContain(RUNBOOK)
  })
})
