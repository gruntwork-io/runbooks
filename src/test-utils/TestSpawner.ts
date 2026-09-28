import { Effect, Layer, Stream } from "effect"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import type { OutputLine, SpawnedProcess } from "../services/ProcessSpawner.ts"
import { SpawnError } from "../errors/index.ts"

export interface SpawnExpectation {
  readonly command: string
  readonly args?: string[]
  readonly outputLines: string[]
  readonly exitCode: number
  readonly source?: "stdout" | "stderr"
}

// ---------------------------------------------------------------------------
// Recording spawner — richer fake for the child-hygiene and exit-contract
// tests: records each spawn's argv + received env, supports mixed
// stdout/stderr lines, spawn-ENOENT simulation, per-spawn delay (for
// serialization assertions), and tracks the max number of concurrently
// running children.
// ---------------------------------------------------------------------------

export interface SpawnResponse {
  readonly lines: OutputLine[]
  readonly exitCode: number
}

export interface RecordedSpawn {
  readonly command: string
  readonly args: string[]
  readonly env?: Record<string, string | undefined>
}

export const makeRecordingSpawner = (
  respond: (command: string, args: string[]) => SpawnResponse | "ENOENT",
  opts: { delayMs?: number } = {},
) => {
  const calls: RecordedSpawn[] = []
  let active = 0
  let maxConcurrent = 0

  const layer = Layer.succeed(ProcessSpawner, {
    spawn: (command, args, options) =>
      Effect.suspend(() => {
        calls.push({ command, args, env: options?.env })
        const response = respond(command, args)
        if (response === "ENOENT") {
          return Effect.fail(
            new SpawnError({
              command,
              cause: Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }),
            }),
          )
        }
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        return Effect.succeed({
          output: Stream.fromIterable(response.lines),
          exitCode: Effect.gen(function* () {
            if (opts.delayMs) yield* Effect.sleep(opts.delayMs)
            active--
            return response.exitCode
          }),
          kill: Effect.void,
        })
      }),
  })

  return { layer, calls, maxConcurrent: () => maxConcurrent }
}

// ---------------------------------------------------------------------------
// Controlled spawner — every spawned process keeps running until the test
// finishes it or something kills it, so tests can interrupt, supersede or
// abandon work while a subprocess is live. Records each spawn and counts
// kills.
// ---------------------------------------------------------------------------

export interface ControlledProcess {
  readonly command: string
  readonly args: string[]
  /** Emit `lines`, then exit with `exitCode`. */
  readonly finish: (exitCode: number, lines?: OutputLine[]) => void
  /**
   * With `deferSpawn`, resolve the pending `spawn` effect. Until then the
   * child exists but its caller has not got hold of it yet.
   */
  readonly completeSpawn: () => void
  readonly killed: () => boolean
}

export const makeControlledSpawner = (opts: { deferSpawn?: boolean } = {}) => {
  const processes: ControlledProcess[] = []
  let kills = 0

  const layer = Layer.succeed(ProcessSpawner, {
    spawn: (command, args) =>
      // Like ChildProcessSpawner, the spawn effect has no canceler: an
      // interrupted caller stops waiting, but the child is already running.
      Effect.async<SpawnedProcess>((resume) => {
        let killed = false
        let finish!: (result: { exitCode: number; lines: OutputLine[] }) => void
        const exited = new Promise<{ exitCode: number; lines: OutputLine[] }>((resolve) => {
          finish = resolve
        })
        const result = Effect.promise(() => exited)
        const spawned: SpawnedProcess = {
          output: Stream.unwrap(Effect.map(result, (r) => Stream.fromIterable(r.lines))),
          exitCode: Effect.map(result, (r) => r.exitCode),
          // A killed process exits the way ChildProcessSpawner reports a
          // signal death: no output left, exit code 1.
          kill: Effect.sync(() => {
            kills++
            killed = true
            finish({ exitCode: 1, lines: [] })
          }),
        }
        const completeSpawn = () => resume(Effect.succeed(spawned))
        processes.push({
          command,
          args,
          finish: (exitCode, lines = []) => finish({ exitCode, lines }),
          completeSpawn,
          killed: () => killed,
        })
        if (!opts.deferSpawn) completeSpawn()
      }),
  })

  return { layer, processes, kills: () => kills }
}

export const makeTestSpawner = (expectations: SpawnExpectation[] = []) =>
  Layer.succeed(ProcessSpawner, {
    spawn: (command, args, _options?) => {
      const match = expectations.find((e) => {
        if (e.command !== command) return false
        if (e.args && JSON.stringify(e.args) !== JSON.stringify(args))
          return false
        return true
      })

      if (!match) {
        return Effect.fail(
          new SpawnError({
            command,
            cause: `unexpected command: ${command} ${(args ?? []).join(" ")}`,
          }),
        )
      }

      return Effect.succeed({
        output: Stream.fromIterable(
          match.outputLines.map((line) => ({
            line,
            source: (match.source ?? "stdout") as "stdout" | "stderr",
          })),
        ),
        exitCode: Effect.succeed(match.exitCode),
        kill: Effect.void,
      })
    },
  })
