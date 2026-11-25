/**
 * For the tests of a run's environment, in the core and with a real shell:
 * three toy tasks, and a trusted session to run them in. Each notes its
 * latest run's input by its label.
 *
 * - `Run` (the toy registry's, labelled by `command`) exports each
 *   `NAME=value` in `args`, a `#` in the value replaced by how many times it
 *   has run.
 * - `Still` is a task that starts no process.
 * - `Shell` runs its `script` with `/bin/bash -c`, handing the spawner the
 *   run's environment, and ends with the exit-code table. It notes what the
 *   script printed.
 */
import { Effect, Fiber, Layer, Redacted, Schema, Stream } from "effect"
import {
  BlockId,
  defineTask,
  endWithExitCode,
  type RunEnv,
  type TaskInput,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import { Engine } from "../engine/engine.ts"
import { Caller, type EventEnvelope } from "../engine/protocol.ts"
import type { FileSystem } from "../services/FileSystem.ts"
import { collectOutput, ProcessSpawner } from "../services/ProcessSpawner.ts"
import { TOY_REGISTRY } from "./toyRegistry.ts"

const blockId = Schema.decodeSync(BlockId)

/** Every variable, revealed, as a block hands them to its process. */
export const revealed = (env: RunEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([name, value]) => [name, Redacted.value(value)]))

interface Noted {
  readonly inputs: Map<string, TaskInput<string>>
  readonly printed: Map<string, ReadonlyArray<string>>
}

const envRegistry = ({ inputs, printed }: Noted) => {
  const runs = new Map<string, number>()
  return {
    ...TOY_REGISTRY,
    Run: defineTask({
      ...TOY_REGISTRY.Run,
      run: (p, input) =>
        Stream.suspend(() => {
          const label = p.command ?? ""
          const count = (runs.get(label) ?? 0) + 1
          runs.set(label, count)
          inputs.set(label, input)
          return Stream.fromIterable(
            (p.args ?? []).map((pair) => {
              const [name = "", ...value] = pair.split("=")
              const given = value.join("=").replace("#", String(count))
              return { _tag: "Env", name, value: Redacted.make(given) } as const
            }),
          )
        }),
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
      props: Schema.Struct({ label: Schema.String, script: Schema.String }),
      children: { kind: "none" },
      references: {},
      runbookFiles: () => [],
      provides: ["run"],
      effects: ["process"],
      outputs: () => ({}),
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
  readonly reset: (block: string) => Effect.Effect<void, unknown, Caller>
  readonly status: (block: string) => Effect.Effect<BlockStatus | undefined, unknown, Caller>
  /** The environment the block's latest run was given, revealed. */
  readonly envOf: (label: string) => Record<string, string>
  readonly inputOf: (label: string) => TaskInput<string> | undefined
  /** What a `Shell` block's latest run printed. */
  readonly printedBy: (label: string) => ReadonlyArray<string> | undefined
  /** Ends the session and returns its whole event log. */
  readonly close: Effect.Effect<ReadonlyArray<EventEnvelope>, unknown, Caller>
}

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
  use: (rb: EnvSession) => Effect.Effect<A, unknown, Engine | Caller>,
): Promise<A> => {
  const noted: Noted = { inputs: new Map(), printed: new Map() }
  return Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* Engine
      const opened = yield* engine.openSession({ path: setup.file })
      if (opened._tag !== "Opened") throw new Error(opened.errors.map((e) => e.message).join())
      const { session, trust } = opened.session
      const recording = yield* Effect.forkChild(Stream.runCollect(engine.events({ session })))
      yield* engine.trustSession({ session, hash: trust.hash })
      const target = (block: string) => ({ session, block: blockId(block) })
      return yield* use({
        run: (block) =>
          Effect.gen(function* () {
            const started = yield* engine.runBlock(target(block))
            if (started._tag !== "Started") throw new Error(`${block}: ${JSON.stringify(started)}`)
            const ended = yield* engine.waitForBlock({ ...target(block), timeoutMillis: 15_000 })
            return ended.block.status
          }),
        reset: (block) => engine.resetBlock(target(block)),
        status: (block) => Effect.map(engine.getBlock(target(block)), (view) => view.status),
        envOf: (label) => {
          const input = noted.inputs.get(label)
          if (input === undefined) throw new Error(`${label} did not run`)
          return revealed(input.env)
        },
        inputOf: (label) => noted.inputs.get(label),
        printedBy: (label) => noted.printed.get(label),
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
