/**
 * GitLab authentication logic.
 *
 * Mirrors src/domain/github/auth.ts, but uses the `glab` CLI and the
 * GITLAB_TOKEN environment variable. GitLab has no OAuth device flow here (no
 * registered Gruntwork GitLab app), so authentication is PAT / CLI / env only.
 */
import { Effect, Stream } from "effect"
import { GitLabClient } from "../../services/GitLabClient.ts"
import type { GitLabTokenType } from "../../services/GitLabClient.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout in milliseconds for the `glab auth token` CLI command. */
const GLAB_CLI_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Token Validation
// ---------------------------------------------------------------------------

/**
 * Validate a GitLab token by calling the GitLab API (GET /user).
 */
export const validateToken = (token: string) =>
  Effect.gen(function* () {
    const glClient = yield* GitLabClient
    return yield* glClient.validateToken(token)
  })

// ---------------------------------------------------------------------------
// Token Type Detection
// ---------------------------------------------------------------------------

/**
 * Determine the type of a GitLab token by inspecting its prefix.
 *
 *   glpat-  -> pat   (personal/project/group access token)
 *   (other) -> unknown
 */
export const detectTokenType = (token: string): GitLabTokenType =>
  token.startsWith("glpat-") ? "pat" : "unknown"

// ---------------------------------------------------------------------------
// Credential Detection
// ---------------------------------------------------------------------------

/**
 * Detect a GitLab token from environment variables.
 * Checks GITLAB_TOKEN (matching getTokenForHost's gitlab.com branch).
 * Returns undefined if it is not set.
 */
export const detectEnvCredentials = () =>
  Effect.gen(function* () {
    const env = yield* Environment

    const gitlabToken = yield* env.get("GITLAB_TOKEN")
    if (gitlabToken) {
      return gitlabToken
    }

    return undefined
  })

/**
 * Detect a GitLab token from the GitLab CLI (`glab auth token`).
 * Runs the command with a 5-second timeout. Returns undefined if the CLI is
 * not installed, not authenticated, or the command fails/times out.
 */
export const detectCliCredentials = () =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner

    const result = yield* Effect.either(
      Effect.gen(function* () {
        const proc = yield* spawner.spawn("glab", ["auth", "token"])

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
              Effect.timeout(GLAB_CLI_TIMEOUT_MS),
            )

            return yield* proc.exitCode.pipe(
              Effect.timeout(GLAB_CLI_TIMEOUT_MS),
            )
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
