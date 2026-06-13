/**
 * GitHub authentication logic.
 */
import { Effect, Stream } from "effect"
import YAML from "yaml"
import { join } from "node:path"
import { GitHubClient } from "../../services/GitHubClient.ts"
import type { GitHubTokenType } from "../../services/GitHubClient.ts"
import { Environment } from "../../services/Environment.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { detectCliToken, buildCliEnv } from "../git/cli-token.ts"
import type { CliEnvOverrides } from "../git/cli-token.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default OAuth client ID for the Gruntwork GitHub OAuth app. */
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liDbtds8EmGws3np"

/** Timeout in milliseconds for the `gh auth token` CLI command. */
const GH_CLI_TIMEOUT_MS = 5_000

/** Timeout for `gh auth status` scope supplementation (best-effort network call). */
const GH_STATUS_TIMEOUT_MS = 10_000

/**
 * Child-env hygiene for every gh spawn (§2.1): strip the ambient token vars so
 * the CLI reports ITS OWN stored credential (a distinct source #3, not an echo
 * of env sources #1/#2), and kill prompts/update checks/color so a spawn can
 * never hang.
 */
export const GH_ENV_OVERRIDES: CliEnvOverrides = {
  // GH_HOST is stripped so no gh spawn can be silently retargeted at a GHES
  // origin — every host-sensitive invocation additionally pins --hostname.
  unset: ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"],
  set: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
}

/**
 * Allowlist for the `{env:{prefix}}` detectCredentials variant (§2.1),
 * enforced in MAIN (the renderer-supplied prefix is untrusted input).
 */
export const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*_$/

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

export interface GitHubEnvCredential {
  readonly token: string
  /** The variable the token came from (e.g. GITHUB_TOKEN, MYAPP_GH_TOKEN). */
  readonly envVar: string
  /**
   * §2.1 both-set-and-differ visibility: set to the LOSING variable when both
   * GITHUB_TOKEN and GH_TOKEN are set with different values, so the UI can
   * surface "GH_TOKEN is also set and differs; Runbooks used GITHUB_TOKEN —
   * gh would use GH_TOKEN." (we keep the golang-tested GITHUB_TOKEN > GH_TOKEN
   * order; gh itself prefers GH_TOKEN).
   */
  readonly shadowedVar?: string
}

/**
 * Detect a GitHub token from environment variables: GITHUB_TOKEN first, then
 * GH_TOKEN (golang-parity order, beta-v0.9.0 api/remote_token_test.go).
 *
 * With a `prefix` (the `{env:{prefix}}` variant, §2.1), looks up
 * `<PREFIX>GITHUB_TOKEN` then `<PREFIX>GH_TOKEN` instead. The prefix MUST
 * already be allowlist-validated (ENV_PREFIX_PATTERN) by the caller in main;
 * an invalid prefix is treated as absent here as defense in depth.
 */
export const detectEnvCredentials = (prefix?: string) =>
  Effect.gen(function* () {
    const env = yield* Environment

    if (prefix !== undefined && prefix !== "") {
      if (!ENV_PREFIX_PATTERN.test(prefix)) {
        return undefined
      }
      const prefixedGithub = yield* env.get(`${prefix}GITHUB_TOKEN`)
      if (prefixedGithub) {
        return { token: prefixedGithub, envVar: `${prefix}GITHUB_TOKEN` } satisfies GitHubEnvCredential
      }
      const prefixedGh = yield* env.get(`${prefix}GH_TOKEN`)
      if (prefixedGh) {
        return { token: prefixedGh, envVar: `${prefix}GH_TOKEN` } satisfies GitHubEnvCredential
      }
      return undefined
    }

    const githubToken = yield* env.get("GITHUB_TOKEN")
    const ghToken = yield* env.get("GH_TOKEN")
    if (githubToken) {
      return {
        token: githubToken,
        envVar: "GITHUB_TOKEN",
        shadowedVar: ghToken && ghToken !== githubToken ? "GH_TOKEN" : undefined,
      } satisfies GitHubEnvCredential
    }
    if (ghToken) {
      return { token: ghToken, envVar: "GH_TOKEN" } satisfies GitHubEnvCredential
    }

    return undefined
  })

/**
 * `gh auth token --hostname github.com` (§2.1 #3): the pin neutralizes
 * GH_HOST and multi-host gh configs; hygiene env via GH_ENV_OVERRIDES. Covers
 * keyring storage (gh ≥ 2.26.0). Undefined when gh is missing,
 * unauthenticated, or times out.
 */
export const detectCliCredentials = () =>
  detectCliToken(
    "gh",
    ["auth", "token", "--hostname", "github.com"],
    GH_CLI_TIMEOUT_MS,
    GH_ENV_OVERRIDES,
  )

// ---------------------------------------------------------------------------
// gh CLI scopes (supplemental, advisory)
// ---------------------------------------------------------------------------

/** Golang-proven tolerant scopes-line regex (beta-v0.9.0 api/github_auth.go). */
const GH_CLI_SCOPE_PATTERN = /Token scopes?:\s*(.+)/

/**
 * Parse OAuth scopes from `gh auth status` output. Tolerates singular
 * "Token scope:", single/double/no quotes, and stray whitespace (the golang
 * test matrix). Returns undefined when no scopes line is present.
 * Exported for testing.
 */
export function parseGhCliScopes(statusOutput: string): string[] | undefined {
  const match = GH_CLI_SCOPE_PATTERN.exec(statusOutput)
  if (!match) return undefined
  const scopes = match[1]
    .split(",")
    .map((scope) => scope.trim().replace(/^['"]|['"]$/g, "").trim())
    .filter((scope) => scope.length > 0)
  return scopes.length > 0 ? scopes : undefined
}

/**
 * Supplement scopes for a CLI-sourced token via
 * `gh auth status --hostname github.com` (§2.1): fine-grained PATs have no
 * X-OAuth-Scopes header, but gh knows its own token's scopes. Output goes to
 * either stream depending on gh version, so both are parsed (golang used
 * CombinedOutput). Failures are ignored — scopes are advisory enrichment.
 */
export const cliScopes = () =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const environment = yield* Environment

    const result = yield* Effect.either(
      Effect.gen(function* () {
        const childEnv = buildCliEnv(yield* environment.getAll(), GH_ENV_OVERRIDES)
        const proc = yield* spawner.spawn(
          "gh",
          ["auth", "status", "--hostname", "github.com"],
          { env: childEnv },
        )
        const lines: string[] = []
        yield* Effect.ensuring(
          Effect.gen(function* () {
            yield* proc.output.pipe(
              Stream.runForEach((line) => Effect.sync(() => lines.push(line.line))),
              Effect.timeout(GH_STATUS_TIMEOUT_MS),
            )
            yield* proc.exitCode.pipe(Effect.timeout(GH_STATUS_TIMEOUT_MS))
          }),
          proc.kill.pipe(Effect.ignore),
        )
        return parseGhCliScopes(lines.join("\n"))
      }),
    )

    return result._tag === "Left" ? undefined : result.right
  })

// ---------------------------------------------------------------------------
// gh hosts.yml (binary-absent-only fallback, §2.1 #3b)
// ---------------------------------------------------------------------------

/**
 * Resolve gh's hosts.yml path. Unlike glab's multi-candidate probe, gh uses
 * EXACTLY ONE config directory — the first defined of $GH_CONFIG_DIR,
 * $XDG_CONFIG_HOME/gh, ~/.config/gh — with no fall-through to later
 * candidates (a set-but-empty GH_CONFIG_DIR directory means "no gh config",
 * not "look in ~/.config/gh"). Exported for testing.
 */
export function resolveGhHostsPath(opts: {
  env: Record<string, string | undefined>
}): string | undefined {
  const { env } = opts
  if (env.GH_CONFIG_DIR) return join(env.GH_CONFIG_DIR, "hosts.yml")
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gh", "hosts.yml")
  const home = env.HOME || env.USERPROFILE || ""
  return home ? join(home, ".config", "gh", "hosts.yml") : undefined
}

export interface GhHostsYmlResult {
  /** The github.com oauth_token, when present on disk. */
  readonly token?: string
  /**
   * Whether a hosts.yml with a github.com entry exists at all. True with no
   * token means gh keyring storage — the caller surfaces "gh stores this
   * token in the OS keyring; install gh or paste a token."
   */
  readonly entryExists: boolean
}

/** Parse the github.com oauth_token from hosts.yml content. Exported for testing. */
export function parseGhHostsToken(yamlContent: string): GhHostsYmlResult {
  try {
    const parsed = YAML.parse(yamlContent, { logLevel: "silent" }) as
      | Record<string, { oauth_token?: unknown } | undefined>
      | null
    const entry = parsed?.["github.com"]
    if (!entry) return { entryExists: false }
    const token = entry.oauth_token
    return {
      entryExists: true,
      token: typeof token === "string" && token.trim().length > 0 ? token.trim() : undefined,
    }
  } catch {
    return { entryExists: false }
  }
}

/**
 * Direct hosts.yml parse — the gh-BINARY-ABSENT-ONLY fallback (§2.1 #3b).
 * Callers must gate on "gh is not installed": when the binary is present,
 * `gh auth token` is authoritative (keyring, token rotation).
 */
export const detectHostsYmlCredentials = () =>
  Effect.gen(function* () {
    const env = yield* Environment
    const fs = yield* FileSystem

    const allEnv = yield* env.getAll()
    const path = resolveGhHostsPath({ env: allEnv })
    if (!path) return { entryExists: false } satisfies GhHostsYmlResult
    const content = yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => ""))
    if (!content) return { entryExists: false } satisfies GhHostsYmlResult
    return parseGhHostsToken(content)
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
