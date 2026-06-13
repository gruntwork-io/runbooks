/**
 * Shared helper for reading an access token from a git provider CLI
 * (`gh auth token`, `glab config get token`). Spawns the command, takes the
 * first stdout line with a timeout, and returns undefined on any failure.
 */
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"

/**
 * Child-environment shaping for CLI spawns (vcs-auth-v2-design.md §2):
 * `unset` strips ambient token vars so the CLI reports its own stored
 * credential (a distinct source, not an echo of the env source — and an env
 * token is never leaked to the wrong host); `set` adds the prompt/update/
 * telemetry kill switches so a spawn can never hang or phone home.
 */
export interface CliEnvOverrides {
  readonly unset: readonly string[]
  readonly set: Readonly<Record<string, string>>
}

/** Build the child env from the ambient environment plus overrides. */
export const buildCliEnv = (
  base: Record<string, string | undefined>,
  overrides: CliEnvOverrides,
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...base }
  for (const name of overrides.unset) {
    delete env[name]
  }
  return { ...env, ...overrides.set }
}

/**
 * Detect an access token by running a provider CLI's token command
 * (e.g. `gh auth token --hostname github.com`). Runs with the given timeout
 * and returns undefined if the CLI is not installed, not authenticated, or the
 * command fails/times out. When `envOverrides` is given, the child env is the
 * ambient environment with the listed vars stripped and the hygiene vars set.
 */
export const detectCliToken = (
  command: string,
  args: string[],
  timeoutMs: number,
  envOverrides?: CliEnvOverrides,
) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const environment = yield* Environment

    const result = yield* Effect.either(
      Effect.gen(function* () {
        const childEnv = envOverrides
          ? buildCliEnv(yield* environment.getAll(), envOverrides)
          : undefined
        const proc = yield* spawner.spawn(command, args, childEnv ? { env: childEnv } : undefined)

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
