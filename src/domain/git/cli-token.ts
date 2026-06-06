/**
 * Shared helper for reading an access token from a git provider CLI
 * (`gh auth token`, `glab auth token`). Spawns the command, takes the first
 * stdout line with a timeout, and returns undefined on any failure.
 */
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"

/**
 * Detect an access token by running a provider CLI's token command
 * (e.g. `gh auth token` or `glab auth token`). Runs with the given timeout and
 * returns undefined if the CLI is not installed, not authenticated, or the
 * command fails/times out.
 */
export const detectCliToken = (
  command: string,
  args: string[],
  timeoutMs: number,
) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner

    const result = yield* Effect.either(
      Effect.gen(function* () {
        const proc = yield* spawner.spawn(command, args)

        // Collect stdout lines with a timeout, ensuring the process is
        // killed when we're done (success, failure, or timeout).
        const lines: string[] = []
        const exitCode = yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* proc.output.pipe(
              Stream.filter((line) => line.source === "stdout"),
              Stream.take(1),
              Stream.runForEach((line) =>
                Effect.sync(() => {
                  lines.push(line.line.trim())
                }),
              ),
              Effect.timeout(timeoutMs),
            )

            return yield* proc.exitCode.pipe(Effect.timeout(timeoutMs))
          }),
          proc.kill.pipe(Effect.ignore),
        )

        if (exitCode !== 0 || lines.length === 0) {
          return undefined
        }

        const token = lines[0]
        return token.length > 0 ? token : undefined
      }),
    )

    // If the command failed for any reason, return undefined
    if (result._tag === "Left") {
      return undefined
    }

    return result.right
  })
