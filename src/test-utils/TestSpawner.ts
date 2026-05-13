import { Effect, Layer, Stream } from "effect"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { SpawnError } from "../errors/index.ts"

export interface SpawnExpectation {
  readonly command: string
  readonly args?: string[]
  readonly outputLines: string[]
  readonly exitCode: number
  readonly source?: "stdout" | "stderr"
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
