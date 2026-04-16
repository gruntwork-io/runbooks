/**
 * GitHub authentication logic.
 * Port of api/github_auth.go.
 */
import { Effect, Stream } from "effect"
import { GitHubClient } from "../../services/GitHubClient.ts"
import type { GitHubTokenType } from "../../services/GitHubClient.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default OAuth client ID for the Gruntwork GitHub OAuth app. */
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liDbtds8EmGws3np"

/** Timeout in milliseconds for the `gh auth token` CLI command. */
const GH_CLI_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Token Validation
// ---------------------------------------------------------------------------

/**
 * Validate a GitHub token by calling the GitHub API (GET /user).
 */
export const validateToken = (token: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.validateToken(token)
  })

// ---------------------------------------------------------------------------
// Token Type Detection
// ---------------------------------------------------------------------------

/**
 * Determine the type of a GitHub token by inspecting its prefix.
 *
 *   ghp_        -> classic_pat
 *   github_pat_ -> fine_grained_pat
 *   gho_        -> oauth
 *   ghs_, ghu_  -> github_app  (installation token / user-to-server)
 *   (other)     -> unknown
 */
export const detectTokenType = (token: string): GitHubTokenType => {
  if (token.startsWith("ghp_")) return "classic_pat"
  if (token.startsWith("github_pat_")) return "fine_grained_pat"
  if (token.startsWith("gho_")) return "oauth"
  if (token.startsWith("ghs_") || token.startsWith("ghu_")) return "github_app"
  return "unknown"
}

// ---------------------------------------------------------------------------
// OAuth Device Flow
// ---------------------------------------------------------------------------

/**
 * Start an OAuth device flow. Returns the device code, user code, and
 * verification URI that should be presented to the user.
 */
export const startOAuthDeviceFlow = (clientId: string, scopes: string[]) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.startOAuthDeviceFlow(clientId, scopes)
  })

/**
 * Poll for the OAuth token after the user has completed browser-based
 * device authorization.
 */
export const pollOAuthToken = (clientId: string, deviceCode: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.pollOAuthToken(clientId, deviceCode)
  })

// ---------------------------------------------------------------------------
// Credential Detection
// ---------------------------------------------------------------------------

/**
 * Detect a GitHub token from environment variables.
 * Checks GITHUB_TOKEN first, then falls back to GH_TOKEN.
 * Returns undefined if neither is set.
 */
export const detectEnvCredentials = () =>
  Effect.gen(function* () {
    const env = yield* Environment

    const githubToken = yield* env.get("GITHUB_TOKEN")
    if (githubToken) {
      return githubToken
    }

    const ghToken = yield* env.get("GH_TOKEN")
    if (ghToken) {
      return ghToken
    }

    return undefined
  })

/**
 * Detect a GitHub token from the GitHub CLI (`gh auth token`).
 * Runs the command with a 5-second timeout. Returns undefined if the CLI is
 * not installed, not authenticated, or the command fails/times out.
 */
export const detectCliCredentials = () =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner

    const result = yield* Effect.either(
      Effect.gen(function* () {
        const proc = yield* spawner.spawn("gh", ["auth", "token"])

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
              Effect.timeout(GH_CLI_TIMEOUT_MS),
            )

            return yield* proc.exitCode.pipe(
              Effect.timeout(GH_CLI_TIMEOUT_MS),
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

// ---------------------------------------------------------------------------
// GitHub API Queries
// ---------------------------------------------------------------------------

/**
 * List organizations the authenticated user belongs to.
 */
export const listOrgs = (token: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listOrgs(token)
  })

/**
 * List repositories for an organization, with optional name filter.
 */
export const listRepos = (token: string, org: string, query?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listRepos(token, org, query)
  })

/**
 * List refs (branches and tags) for a repository, with optional filter.
 */
export const listRefs = (
  token: string,
  owner: string,
  repo: string,
  query?: string,
) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listRefs(token, owner, repo, query)
  })

/**
 * List labels defined on a repository.
 */
export const listLabels = (token: string, owner: string, repo: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listLabels(token, owner, repo)
  })
