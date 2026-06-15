import { Effect, Layer, Stream } from "effect"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import type { OutputLine } from "../services/ProcessSpawner.ts"
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
