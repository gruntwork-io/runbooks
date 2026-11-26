/**
 * For the tests of a run's environment and the files its script writes,
 * in the core and with a real shell: four toy tasks, and a trusted session
 * to run them in. Each notes its latest run's input by its label.
 *
 * - `Run` (the toy registry's, labelled by `command`) writes each line in
 *   `args` to `$RUNBOOK_ENV`, a `#` in it replaced by how many times it has
 *   run.
 * - `Script` writes `writesOutput` to `$RUNBOOK_OUTPUT` and `writesEnv` to
 *   `$RUNBOOK_ENV`, then ends as `ends` says for that run (the first entry
 *   for its first run, and so on, the last for every run after): with an
 *   exit code, by timing out, or never, until it is stopped. Unset, it
 *   exits 0. It declares the outputs in `declares`; one whose name starts
 *   with `secret` is sensitive.
 * - `Still` is a task that starts no process.
 * - `Shell` runs its `script` with `/bin/bash -c`, handing the spawner the
 *   run's environment, and ends with the exit-code table. It notes what the
 *   script printed, and declares the outputs in `declares`.
 *
 * Credential blocks open their providers from `providers`, which by default
 * has none, so each such block is Unavailable. With `testClock`, time moves
 * only when the test adjusts it.
 */

import { Clock, Duration, Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  BlockId,
  defineTask,
  endWithExitCode,
  type RunEnv,
  type TaskEvent,
  type TaskInput,
  TaskFailed,
  TaskTimedOut,
} from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import type {
  CredentialAction,
  CredentialState,
  CredentialStateTag,
} from "../credential/lifecycle.ts"
import type { CredentialProviders } from "../credential/provider.ts"
import { Engine } from "../engine/engine.ts"
import type { SettingsStore } from "../engine/settings.ts"
import {
  type ActResult,
  type BlockView,
  Caller,
  type EventEnvelope,
  type OutputView,
} from "../engine/protocol.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { collectOutput, ProcessSpawner } from "../services/ProcessSpawner.ts"
import { testCredentialProviders } from "./TestCredentialProviders.ts"
import { testSettingsStore } from "./TestSettingsFile.ts"
import { testSessionStore } from "./TestSessionStore.ts"
import { TOY_REGISTRY } from "./toyRegistry.ts"

const blockId = Schema.decodeSync(BlockId)

/**
 * `clock`, with its wall time read `ahead()` milliseconds later: a machine
 * that slept, as its timers see it. Its sleeps and its monotonic time are
 * still `clock`'s, and `TestClock.adjust` still moves `clock`.
 */
const aheadBy = (clock: TestClock.TestClock, ahead: () => number): TestClock.TestClock => {
  const millis = () => clock.currentTimeMillisUnsafe() + ahead()
  const nanos = () => clock.currentTimeNanosUnsafe() + BigInt(ahead()) * BigInt(1_000_000)
  return {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) => clock.sleep(duration),
    adjust: (duration) => clock.adjust(duration),
    setTime: (timestamp) => clock.setTime(timestamp),
    withLive: (effect) => clock.withLive(effect),
  }
}

/** Every variable, revealed, as a block hands them to its process. */
export const revealed = (env: RunEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([name, value]) => [name, Redacted.value(value)]))

/** The two variables that name the files a run's script writes to. */
const RUN_FILES = ["RUNBOOK_OUTPUT", "RUNBOOK_ENV"] as const

/** The variables the engine sets for a process task's run: its files, and the folders it writes to. */
const RUN_VARIABLES: ReadonlyArray<string> = [...RUN_FILES, "GENERATED_FILES", "REPO_FILES"]

/** Appends `lines` to the run file `file`, as a script would. */
const write = (
  input: TaskInput<string>,
  file: (typeof RUN_FILES)[number],
  lines: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (lines.length === 0) return
    const at = input.env[file]
    if (at === undefined) return yield* new TaskFailed({ message: `The run has no ${file}.` })
    const fs = yield* FileSystem
    yield* fs
      .appendFile(Redacted.value(at), lines.map((line) => `${line}\n`).join(""))
      .pipe(Effect.mapError(() => new TaskFailed({ message: `${file} could not be written.` })))
  })

/** Leaves each `path=content` file in the run's `$GENERATED_FILES`, as a script would. */
const leave = (input: TaskInput<string>, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const folder = input.env["GENERATED_FILES"]
    if (files.length === 0) return
    if (folder === undefined)
      return yield* new TaskFailed({ message: "The run has no GENERATED_FILES." })
    const fs = yield* FileSystem
    for (const file of files) {
      const [name = "", content = ""] = file.split("=")
      yield* fs
        .writeFile(`${Redacted.value(folder)}/${name}`, content)
        .pipe(Effect.mapError(() => new TaskFailed({ message: `${name} could not be written.` })))
    }
  })

const declared = (names: ReadonlyArray<string> | undefined) =>
  Object.fromEntries((names ?? []).map((key) => [key, { sensitive: key.startsWith("secret") }]))

interface Noted {
  readonly inputs: Map<string, TaskInput<string>>
  readonly printed: Map<string, ReadonlyArray<string>>
  /** How many times each `Script` has written its files. */
  readonly wrote: Map<string, number>
}

const envRegistry = ({ inputs, printed, wrote }: Noted) => {
  const runs = new Map<string, number>()
  return {
    ...TOY_REGISTRY,
    Run: defineTask({
      ...TOY_REGISTRY.Run,
      run: (p, input) =>
        Stream.fromEffectDrain(
          Effect.suspend(() => {
            const label = p.command ?? ""
            const count = (runs.get(label) ?? 0) + 1
            runs.set(label, count)
            inputs.set(label, input)
            const lines = (p.args ?? []).map((line) => line.replace("#", String(count)))
            return write(input, "RUNBOOK_ENV", lines)
          }),
        ),
    }),
    Script: defineTask({
      name: "Script",
      since: "0.1.0",
      class: "task",
      props: Schema.Struct({
        label: Schema.String,
        writesOutput: Schema.optionalKey(Schema.Array(Schema.String)),
        writesEnv: Schema.optionalKey(Schema.Array(Schema.String)),
        /** Files to leave in `$GENERATED_FILES`, each `path=content`. */
        writesGenerated: Schema.optionalKey(Schema.Array(Schema.String)),
        /** How many more files to leave in `$GENERATED_FILES`, `many/0` and on. */
        leavesMany: Schema.optionalKey(Schema.Int),
        /**
         * Reports this many files created, `/reported/0` and on, then
         * `/reported/0` again as modified, as a task that writes files itself does.
         */
        reports: Schema.optionalKey(Schema.Int),
        /** The block that makes the repository the run starts in. */
        repository: Schema.optionalKey(BlockId),
        declares: Schema.optionalKey(Schema.Array(Schema.String)),
        ends: Schema.optionalKey(
          Schema.Array(Schema.Union([Schema.Int, Schema.Literals(["timeout", "never"])])),
        ),
      }),
      children: { kind: "none" },
      references: { repository: "repository" },
      runbookFiles: () => [],
      provides: ["run", "env"],
      effects: ["process"],
      outputs: (p) => declared(p.declares),
      run: (p, input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            inputs.set(p.label, input)
            yield* write(input, "RUNBOOK_OUTPUT", p.writesOutput ?? [])
            yield* write(input, "RUNBOOK_ENV", p.writesEnv ?? [])
            yield* leave(input, [
              ...(p.writesGenerated ?? []),
              ...Array.from({ length: p.leavesMany ?? 0 }, (_, i) => `many/${i}=${i}`),
            ])
            const count = wrote.get(p.label) ?? 0
            wrote.set(p.label, count + 1)
            const ends = p.ends ?? [0]
            const how = ends[Math.min(count, ends.length - 1)] ?? 0
            const end: Stream.Stream<TaskEvent<never>, TaskFailed | TaskTimedOut> = how ===
            "timeout"
              ? Stream.fail(new TaskTimedOut({ afterMillis: 50 }))
              : how === "never"
                ? Stream.never
                : endWithExitCode(how)
            const reported = Array.from({ length: p.reports ?? 0 }, (_, i) => `/reported/${i}`)
            const reports: ReadonlyArray<TaskEvent<never>> = [
              ...reported.map((path) => ({
                _tag: "File" as const,
                path,
                change: "created" as const,
              })),
              ...reported
                .slice(0, 1)
                .map((path) => ({ _tag: "File" as const, path, change: "modified" as const })),
            ]
            return Stream.concat(Stream.fromIterable(reports), end)
          }),
        ),
      instruction: () => [],
      plugins: [],
    }),
    Still: defineTask({
      ...TOY_REGISTRY.Run,
      name: "Still",
      effects: ["files"],
      provides: ["run"],
      run: (p, input) =>
        Stream.fromEffectDrain(Effect.sync(() => inputs.set(p.command ?? "", input))),
    }),
    Shell: defineTask({
      name: "Shell",
      since: "0.1.0",
      class: "task",
      props: Schema.Struct({
        label: Schema.String,
        script: Schema.String,
        declares: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
      children: { kind: "none" },
      references: {},
      runbookFiles: () => [],
      provides: ["run", "env"],
      effects: ["process"],
      outputs: (p) => declared(p.declares),
      run: (p, input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            inputs.set(p.label, input)
            const spawner = yield* ProcessSpawner
            const proc = yield* spawner.spawn("/bin/bash", ["-c", p.script], {
              env: revealed(input.env),
              cwd: input.cwd,
            })
            const { exitCode, lines } = yield* collectOutput(proc, 10_000)
            printed.set(
              p.label,
              lines.flatMap(({ line, source }) => (source === "stdout" ? [line] : [])),
            )
            return endWithExitCode(exitCode)
          }).pipe(Effect.mapError((error) => new TaskFailed({ message: `bash: ${error._tag}` }))),
        ),
      instruction: () => [],
      plugins: [],
    }),
  }
}

export interface EnvSession {
  /** Runs the block and waits for it to end. */
  readonly run: (block: string) => Effect.Effect<BlockStatus | undefined, unknown, Caller>
  /** Starts the block's run and does not wait. */
  readonly start: (block: string) => Effect.Effect<void, unknown, Caller>
  /** Waits for the block to stop running. */
  readonly wait: (block: string) => Effect.Effect<BlockStatus | undefined, unknown, Caller>
  /** Stops the block's run and waits for it to end. */
  readonly stop: (block: string) => Effect.Effect<BlockStatus | undefined, unknown, Caller>
  readonly reset: (block: string) => Effect.Effect<void, unknown, Caller>
  readonly status: (block: string) => Effect.Effect<BlockStatus | undefined, unknown, Caller>
  /** Every block's published outputs. */
  readonly outputs: Effect.Effect<
    Readonly<Record<string, Readonly<Record<string, OutputView>>>>,
    unknown,
    Caller
  >
  /**
   * The environment the block's latest run was given, revealed, less the
   * variables the engine sets for its run (`runFilesOf`).
   */
  readonly envOf: (label: string) => Record<string, string>
  /** The variables the engine set for the block's latest run: where it writes its files, and `$REPO_FILES`. */
  readonly runFilesOf: (label: string) => Record<string, string>
  readonly inputOf: (label: string) => TaskInput<string> | undefined
  /** How many times a `Script` block has written its files. */
  readonly wrote: (label: string) => number
  /** What a `Shell` block's latest run printed. */
  readonly printedBy: (label: string) => ReadonlyArray<string> | undefined
  readonly view: (block: string) => Effect.Effect<BlockView, unknown, Caller>
  /** Acts on a credential block. */
  readonly act: (
    block: string,
    action: CredentialAction,
  ) => Effect.Effect<ActResult, unknown, Caller>
  /**
   * The next state `tag` the credential block moves to, after the one the
   * last `until` for that block returned. Fails if it does not come within
   * five seconds.
   */
  readonly until: (
    block: string,
    tag: CredentialStateTag,
  ) => Effect.Effect<CredentialState, unknown, Caller>
  /** Ends the session and returns its whole event log. */
  readonly close: Effect.Effect<ReadonlyArray<EventEnvelope>, unknown, Caller>
}

/** What a test does with its session. It may change the settings the engine reads. */
export type UseEnvSession<A> = (
  rb: EnvSession,
) => Effect.Effect<A, unknown, Engine | Caller | SettingsStore>

/** Opens the runbook at `file`, trusts it, and gives `use` its commands. */
export const withEnvSession = <A>(
  setup: {
    readonly file: string
    readonly workingFolders: string
    /** The app's process environment, as the entry point reads it. */
    readonly processEnvironment: Readonly<Record<string, string>>
    readonly fileSystem: Layer.Layer<FileSystem>
    readonly spawner: Layer.Layer<ProcessSpawner>
    /** The providers, which may write files where the engine reads them. */
    readonly providers?: Layer.Layer<CredentialProviders, never, FileSystem>
    /** The engine's settings, and the test's: the defaults, unless given. */
    readonly settings?: Layer.Layer<SettingsStore>
    readonly testClock?: boolean
    /** On the test clock: how far the wall clock has jumped ahead of it, as after the machine slept. */
    readonly wallClockAhead?: () => number
  },
  use: UseEnvSession<A>,
): Promise<A> => {
  const noted: Noted = { inputs: new Map(), printed: new Map(), wrote: new Map() }
  return Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* Engine
      const opened = yield* engine.openSession({ path: setup.file })
      if (opened._tag !== "Opened") throw new Error(opened.errors.map((e) => e.message).join())
      const { session, trust } = opened.session
      const recording = yield* Effect.forkChild(Stream.runCollect(engine.events({ session })))
      yield* engine.trustSession({ session, hash: trust.hash })
      const target = (block: string) => ({ session, block: blockId(block) })
      const start = (block: string) =>
        Effect.gen(function* () {
          const started = yield* engine.runBlock(target(block))
          if (started._tag !== "Started") throw new Error(`${block}: ${JSON.stringify(started)}`)
        })
      const wait = (block: string) =>
        Effect.map(
          engine.waitForBlock({ ...target(block), timeoutMillis: 15_000 }),
          (ended) => ended.block.status,
        )
      const envGiven = (label: string) => {
        const input = noted.inputs.get(label)
        if (input === undefined) throw new Error(`${label} did not run`)
        return Object.entries(revealed(input.env))
      }
      const isRunFile = (name: string) => RUN_VARIABLES.includes(name)
      /** Each block's last state `until` returned, by its sequence. */
      const cursors = new Map<string, number>()
      const until = (block: string, tag: CredentialStateTag) => {
        const after = cursors.get(block)
        return engine.events({ session, ...(after === undefined ? {} : { after }) }).pipe(
          Stream.filter(
            (envelope) =>
              envelope.event._tag === "CredentialChanged" &&
              envelope.event.block === block &&
              envelope.event.state._tag === tag,
          ),
          Stream.runHead,
          Effect.flatMap(Effect.fromOption),
          Effect.timeoutOrElse({
            duration: Duration.seconds(5),
            orElse: () => Effect.die(new Error(`${block} did not move to ${tag}`)),
          }),
          Effect.flatMap(({ sequence, event }) => {
            cursors.set(block, sequence)
            return event._tag === "CredentialChanged"
              ? Effect.succeed(event.state)
              : Effect.die(event)
          }),
        )
      }
      return yield* use({
        run: (block) => Effect.andThen(start(block), wait(block)),
        start,
        wait,
        stop: (block) => Effect.andThen(engine.cancelBlock(target(block)), wait(block)),
        reset: (block) => engine.resetBlock(target(block)),
        status: (block) => Effect.map(engine.getBlock(target(block)), (view) => view.status),
        outputs: engine.getOutputs({ session }),
        envOf: (label) => Object.fromEntries(envGiven(label).filter(([name]) => !isRunFile(name))),
        runFilesOf: (label) =>
          Object.fromEntries(envGiven(label).filter(([name]) => isRunFile(name))),
        inputOf: (label) => noted.inputs.get(label),
        printedBy: (label) => noted.printed.get(label),
        wrote: (label) => noted.wrote.get(label) ?? 0,
        view: (block) => engine.getBlock(target(block)),
        act: (block, action) => engine.actOnCredential({ ...target(block), action }),
        until,
        close: Effect.andThen(engine.closeSession({ session }), Fiber.join(recording)),
      })
    }).pipe(
      Effect.provide(
        Engine.layer({
          registry: envRegistry(noted),
          appVersion: "0.31.0",
          workingFolders: setup.workingFolders,
          stateFolders: "/state",
          processEnvironment: setup.processEnvironment,
        }),
      ),
      Effect.provide(setup.providers ?? testCredentialProviders({}, [])),
      Effect.provide(setup.settings ?? testSettingsStore()),
      Effect.provide(testSessionStore()),
      Effect.provide(Layer.merge(setup.fileSystem, setup.spawner)),
      Effect.provideService(Caller, { origin: "person" }),
      (effect) => {
        const ahead = setup.wallClockAhead
        return ahead === undefined
          ? effect
          : TestClock.testClockWith((clock) =>
              Effect.provideService(effect, Clock.Clock, aheadBy(clock, ahead)),
            )
      },
      setup.testClock === true ? Effect.provide(TestClock.layer()) : (effect) => effect,
    ),
  )
}
