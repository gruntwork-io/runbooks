/**
 * Live implementation of the ProcessSpawner service using child_process.spawn.
 */
import { spawn as cpSpawn } from "node:child_process"
import * as readline from "node:readline"
import { Effect, Layer, Stream } from "effect"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import type { ProcessSpawnerShape, SpawnedProcess, OutputLine, SpawnOptions } from "../services/ProcessSpawner.ts"
import { SpawnError } from "../errors/index.ts"

const impl: ProcessSpawnerShape = {
  spawn: (command: string, args: string[], options?: SpawnOptions) =>
    Effect.try({
      try: (): SpawnedProcess => {
        const proc = cpSpawn(command, args, {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: ["pipe", "pipe", "pipe"],
        })

        // Write stdin if provided, then close
        if (options?.stdin && proc.stdin) {
          proc.stdin.write(options.stdin)
          proc.stdin.end()
        }

        const output: Stream.Stream<OutputLine> = Stream.async<OutputLine>((emit) => {
          if (proc.stdout) {
            const stdoutRl = readline.createInterface({ input: proc.stdout })
            stdoutRl.on("line", (line) => {
              emit.single({ line, source: "stdout" as const })
            })
          }

          if (proc.stderr) {
            const stderrRl = readline.createInterface({ input: proc.stderr })
            stderrRl.on("line", (line) => {
              emit.single({ line, source: "stderr" as const })
            })
          }

          proc.on("close", () => {
            emit.end()
          })

          proc.on("error", () => {
            emit.end()
          })
        })

        const exitCode: Effect.Effect<number> = Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              proc.on("close", (code) => {
                resolve(code ?? 1)
              })
              proc.on("error", () => {
                resolve(1)
              })
            }),
        )

        const kill: Effect.Effect<void> = Effect.sync(() => {
          proc.kill()
        })

        return { output, exitCode, kill }
      },
      catch: (err) => new SpawnError({ command, cause: err }),
    }),
}

export const ChildProcessSpawnerLive = Layer.succeed(ProcessSpawner, impl)
