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
 */
import { Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect"
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
import { Engine } from "../engine/engine.ts"
import { Caller, type EventEnvelope, type OutputView } from "../engine/protocol.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { collectOutput, ProcessSpawner } from "../services/ProcessSpawner.ts"
import { TOY_REGISTRY } from "./toyRegistry.ts"

const blockId = Schema.decodeSync(BlockId)

/** Every variable, revealed, as a block hands them to its process. */
export const revealed = (env: RunEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([name, value]) => [name, Redacted.value(value)]))

/** The two variables that name the files a run's script writes to. */
const RUN_FILES = ["RUNBOOK_OUTPUT", "RUNBOOK_ENV"] as const

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
        declares: Schema.optionalKey(Schema.Array(Schema.String)),
        ends: Schema.optionalKey(
          Schema.Array(Schema.Union([Schema.Int, Schema.Literals(["timeout", "never"])])),
        ),
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
            yield* write(input, "RUNBOOK_OUTPUT", p.writesOutput ?? [])
            yield* write(input, "RUNBOOK_ENV", p.writesEnv ?? [])
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
            return end
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
   * two variables that name its run files (`runFilesOf`).
   */
  readonly envOf: (label: string) => Record<string, string>
  /** Where the block's latest run was told to write `$RUNBOOK_OUTPUT` and `$RUNBOOK_ENV`. */
  readonly runFilesOf: (label: string) => Record<string, string>
  readonly inputOf: (label: string) => TaskInput<string> | undefined
  /** How many times a `Script` block has written its files. */
  readonly wrote: (label: string) => number
  /** What a `Shell` block's latest run printed. */
  readonly printedBy: (label: string) => ReadonlyArray<string> | undefined
  /** Ends the session and returns its whole event log. */
  readonly close: Effect.Effect<ReadonlyArray<EventEnvelope>, unknown, Caller>
}

/** What a test does with its session. */
export type UseEnvSession<A> = (rb: EnvSession) => Effect.Effect<A, unknown, Engine | Caller>

/** Opens the runbook at `file`, trusts it, and gives `use` its commands. */
export const withEnvSession = <A>(
  setup: {
    readonly file: string
    readonly workingFolders: string
    /** The app's process environment, as the entry point reads it. */
    readonly processEnvironment: Readonly<Record<string, string>>
    readonly fileSystem: Layer.Layer<FileSystem>
    readonly spawner: Layer.Layer<ProcessSpawner>
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
      const isRunFile = (name: string) => RUN_FILES.some((file) => file === name)
      return yield* use({
        run: (block) => Effect.andThen(start(block), wait(block)),
        start,
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
        close: Effect.andThen(engine.closeSession({ session }), Fiber.join(recording)),
      })
    }).pipe(
      Effect.provide(
        Engine.layer({
          registry: envRegistry(noted),
          appVersion: "0.31.0",
          workingFolders: setup.workingFolders,
          processEnvironment: setup.processEnvironment,
        }),
      ),
      Effect.provide(Layer.merge(setup.fileSystem, setup.spawner)),
      Effect.provideService(Caller, { origin: "person" }),
    ),
  )
}
