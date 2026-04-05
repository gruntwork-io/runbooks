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
        const needsStdin = Boolean(options?.stdin)
        const proc = cpSpawn(command, args, {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: [needsStdin ? "pipe" : "ignore", "pipe", "pipe"],
        })

        // Write stdin if provided, then close
        if (needsStdin && proc.stdin) {
          proc.stdin.write(options!.stdin)
          proc.stdin.end()
        }

        // Use "unbounded" buffer to avoid backpressure deadlocks — the
        // emit.single() / emit.end() methods return Promises, and Node.js
        // event callbacks cannot await them. With an unbounded buffer the
        // promises resolve immediately so fire-and-forget is safe.
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
        }, "unbounded")

        // Register the close/error listener eagerly (synchronously) so we
        // capture the exit code even if the process finishes before the
        // Effect is evaluated. Effect.promise is lazy — if we created the
        // Promise inside it, a fast-exiting process would fire "close"
        // before the listener was attached.
        const exitCodePromise = new Promise<number>((resolve) => {
          proc.on("close", (code) => {
            resolve(code ?? 1)
          })
          proc.on("error", () => {
            resolve(1)
          })
        })
        const exitCode: Effect.Effect<number> = Effect.promise(() => exitCodePromise)

        const kill: Effect.Effect<void> = Effect.sync(() => {
          proc.kill()
        })

        return { output, exitCode, kill }
      },
      catch: (err) => new SpawnError({ command, cause: err }),
    }),
}

export const ChildProcessSpawnerLive = Layer.succeed(ProcessSpawner, impl)
