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

        // Collect output lines eagerly. We do NOT use Effect streams
        // (Stream.async, Stream.asyncPush) because they have a fundamental
        // issue: emit.end() called from a Node.js event callback does not
        // reliably terminate the stream within Effect's runtime after
        // multiple sequential invocations. Instead, we collect lines into
        // an array and resolve a Promise when the process closes.
        const collectedLines: OutputLine[] = []

        if (proc.stdout) {
          const stdoutRl = readline.createInterface({ input: proc.stdout })
          stdoutRl.on("line", (line) => {
            collectedLines.push({ line, source: "stdout" as const })
          })
        }

        if (proc.stderr) {
          const stderrRl = readline.createInterface({ input: proc.stderr })
          stderrRl.on("line", (line) => {
            collectedLines.push({ line, source: "stderr" as const })
          })
        }

        // Single exit promise — eagerly registered to never miss the event.
        const exitPromise = new Promise<number>((resolve) => {
          proc.on("close", (code) => resolve(code ?? 1))
          proc.on("error", () => resolve(1))
        })

        // Output: wait for exit, then return collected lines.
        // Uses Effect.tryPromise to bridge the Node.js Promise.
        const output: Stream.Stream<OutputLine> = Stream.fromEffect(
          Effect.tryPromise({
            try: () => exitPromise.then(() => [...collectedLines]),
            catch: () => new SpawnError({ command, cause: new Error("Process failed") }),
          }),
        ).pipe(
          Stream.flatMap((lines) => Stream.fromIterable(lines)),
        )

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
