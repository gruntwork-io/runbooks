/**
 * Live implementation of the ProcessSpawner service using child_process.spawn.
 */
import { spawn as cpSpawn } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"
import * as readline from "node:readline"
import { Effect, Layer, Option, Stream } from "effect"
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

        // Optional durable log file. When a path is given, every line is appended
        // (in arrival order, both streams interleaved) as it arrives, so the file
        // can be tailed externally and inspected after the run. Writing is
        // best-effort: a file error must never break execution or streaming.
        let logFile: WriteStream | null = null
        if (options?.logFilePath) {
          try {
            logFile = createWriteStream(options.logFilePath, { flags: "a" })
            logFile.on("error", () => {
              logFile = null
            })
          } catch {
            logFile = null
          }
        }

        // Lines are collected into an array and the `output` stream tails that
        // array live (see below). We deliberately avoid Stream.async /
        // Stream.asyncPush: emit.end() called from a Node.js event callback does
        // not reliably terminate the stream within Effect's runtime after
        // multiple sequential invocations. Polling a plain array with a
        // controlled "closed" flag sidesteps that entirely.
        const collectedLines: OutputLine[] = []
        let streamClosed = false

        const record = (line: string, source: "stdout" | "stderr") => {
          collectedLines.push({ line, source })
          logFile?.write(line + "\n")
        }

        if (proc.stdout) {
          const stdoutRl = readline.createInterface({ input: proc.stdout })
          stdoutRl.on("line", (line) => record(line, "stdout"))
        }

        if (proc.stderr) {
          const stderrRl = readline.createInterface({ input: proc.stderr })
          stderrRl.on("line", (line) => record(line, "stderr"))
        }

        // Single exit promise — eagerly registered to never miss the event.
        // The process "close" event fires after all stdio streams have ended, so
        // by the time it runs every readline "line" event has already been
        // delivered into collectedLines.
        const exitPromise = new Promise<number>((resolve) => {
          const finish = (code: number) => {
            streamClosed = true
            logFile?.end()
            resolve(code)
          }
          proc.on("close", (code) => finish(code ?? 1))
          proc.on("error", () => finish(1))
        })

        // Output: tail collectedLines live. Each pull emits the next buffered
        // line; when none are pending it polls until more arrive, and once the
        // process has closed it drains any remaining lines and then ends.
        let cursor = 0
        const pullLine: Effect.Effect<OutputLine, Option.Option<never>> = Effect.gen(
          function* () {
            while (true) {
              if (cursor < collectedLines.length) {
                return collectedLines[cursor++]
              }
              if (streamClosed) {
                return yield* Effect.fail(Option.none<never>())
              }
              yield* Effect.sleep("50 millis")
            }
          },
        )
        const output: Stream.Stream<OutputLine> = Stream.repeatEffectOption(pullLine)

        const exitCode: Effect.Effect<number> = Effect.tryPromise({
          try: () => exitPromise,
          catch: () => new SpawnError({ command, cause: new Error("Process failed") }),
        }) as unknown as Effect.Effect<number>

        const kill: Effect.Effect<void> = Effect.sync(() => {
          proc.kill()
        })

        return { output, exitCode, kill }
      },
      catch: (err) => new SpawnError({ command, cause: err }),
    }),
}

export const ChildProcessSpawnerLive = Layer.succeed(ProcessSpawner, impl)
