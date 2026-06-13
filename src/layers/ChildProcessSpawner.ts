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
    // Effect.async, not Effect.try: Node reports a missing binary (ENOENT)
    // asynchronously via the child's "error" event — cpSpawn itself returns
    // normally. The effect resolves only on the "spawn"/"error" race, so a
    // missing binary FAILS the spawn effect (as every test spawner already
    // simulates) instead of masquerading as a successful spawn that exited 1.
    Effect.async<SpawnedProcess, SpawnError>((resume) => {
      try {
        const needsStdin = Boolean(options?.stdin)
        const proc = cpSpawn(command, args, {
          cwd: options?.cwd,
          env: options?.env as NodeJS.ProcessEnv | undefined,
          stdio: [needsStdin ? "pipe" : "ignore", "pipe", "pipe"],
          // Run the child as its own process-group leader (POSIX: pid === pgid).
          // Scripts here spawn a tree — bash → terragrunt → tofu → providers —
          // and `kill` below signals the whole group via the negative pid. Without
          // this, terminating only the direct child would orphan the grandchildren
          // (terraform/tofu would keep running and hold state locks).
          detached: true,
        })

        // Write stdin if provided, then close. The no-op error handler keeps a
        // failed spawn (or an early-exiting child) from surfacing the buffered
        // write as an uncaught stream error.
        if (needsStdin && proc.stdin) {
          proc.stdin.on("error", () => {})
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
        // delivered into collectedLines. The "error" branch only matters for a
        // post-spawn error (e.g. a failed kill): a PRE-spawn error fails the
        // whole effect below and nobody ever consumes this promise.
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

        // Kill the entire process group, not just the direct child. `detached`
        // above makes `proc` a group leader, so a negative pid signals every
        // descendant that hasn't started its own group (bash, terragrunt, tofu,
        // providers all stay in this group).
        const killGroup = (signal: NodeJS.Signals): void => {
          const pid = proc.pid
          if (pid === undefined) return
          try {
            process.kill(-pid, signal)
          } catch {
            // Group already gone, or the platform lacks group signals (Windows):
            // fall back to the direct child. A second failure means it's dead.
            try {
              proc.kill(signal)
            } catch {
              /* already exited — nothing to do */
            }
          }
        }

        const kill: Effect.Effect<void> = Effect.sync(() => {
          // Ask politely first so the tree can clean up (e.g. tofu releases its
          // state lock), then force-kill whatever is still alive a few seconds
          // later. The escalation timer is best-effort and unref'd so it can
          // never, on its own, keep the parent process alive.
          killGroup("SIGTERM")
          const escalate = setTimeout(() => killGroup("SIGKILL"), 5000)
          escalate.unref?.()
        })

        const spawned: SpawnedProcess = { output, exitCode, kill }
        // Whichever fires first wins; Effect.async ignores later resumes, so a
        // post-spawn "error" event is handled by exitPromise above instead.
        proc.once("spawn", () => resume(Effect.succeed(spawned)))
        proc.once("error", (err) => resume(Effect.fail(new SpawnError({ command, cause: err }))))
      } catch (err) {
        resume(Effect.fail(new SpawnError({ command, cause: err })))
      }
    }),
}

export const ChildProcessSpawnerLive = Layer.succeed(ProcessSpawner, impl)
