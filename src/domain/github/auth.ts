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
import {
  DEFAULT_GITHUB_HOST,
  githubHostKind,
  tryNormalizeGitHubHost,
} from "../git/github-host.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default OAuth client ID for the Gruntwork GitHub OAuth app. Registered on
 * github.com ONLY — it does not exist on a GHES or ghe.com instance, so it is
 * never used for one (see resolveOAuthClientId).
 */
export const DEFAULT_GITHUB_OAUTH_CLIENT_ID = "Ov23liDbtds8EmGws3np"

/** Timeout in milliseconds for the `gh auth token` CLI command. */
const GH_CLI_TIMEOUT_MS = 5_000

/** Timeout for `gh auth status` scope supplementation (best-effort network call). */
const GH_STATUS_TIMEOUT_MS = 10_000

/**
 * Child-env hygiene for every gh spawn: strip the ambient token vars so
 * the CLI reports ITS OWN stored credential (a distinct source #3, not an echo
 * of env sources #1/#2), and kill prompts/update checks/color so a spawn can
 * never hang.
 */
export const GH_ENV_OVERRIDES: CliEnvOverrides = {
  // GH_HOST is stripped so no gh spawn can be silently retargeted at another
  // host — every host-sensitive invocation additionally pins --hostname. The
  // enterprise token vars are stripped for the same reason as GH_TOKEN: gh
  // must report ITS OWN stored credential for the pinned host.
  unset: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"],
  set: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
}

/**
 * Allowlist for the `{env:{prefix}}` detectCredentials variant,
 * enforced in MAIN (the renderer-supplied prefix is untrusted input).
 */
export const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*_$/

// ---------------------------------------------------------------------------
// Token Validation
// ---------------------------------------------------------------------------

/**
 * Validate a GitHub token by calling the host's API (GET /user). `host`
 * defaults to github.com.
 */
export const validateToken = (token: string, host?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.validateToken(token, host)
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
export const startOAuthDeviceFlow = (clientId: string, scopes: string[], host?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.startOAuthDeviceFlow(clientId, scopes, host)
  })

/**
 * Poll for the OAuth token after the user has completed browser-based
 * device authorization.
 */
export const pollOAuthToken = (clientId: string, deviceCode: string, host?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.pollOAuthToken(clientId, deviceCode, host)
  })

/**
 * Pick the OAuth app client ID for a device flow against `host`, or
 * undefined when none may be used. github.com falls back to the Gruntwork
 * app; an enterprise host (GHES or ghe.com) needs an OAuth app registered on
 * THAT instance, so it gets only an explicitly configured client ID — never
 * the github.com default, and never a silent switch to github.com. The caller
 * offers PAT and gh-CLI sign-in instead.
 */
export const resolveOAuthClientId = (host: string, configured?: string): string | undefined => {
  const clientId = configured?.trim() || undefined
  return githubHostKind(host) === "dotcom" ? (clientId ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID) : clientId
}

/** User-facing copy for an enterprise host with no OAuth app configured. */
export const oauthUnavailableMessage = (host: string): string =>
  `Sign-in with GitHub isn't set up for ${host}: it needs an OAuth app registered on that instance ` +
  `(the block's oauthClientId). Use a personal access token or 'gh auth login --hostname ${host}' instead.`

// ---------------------------------------------------------------------------
// Credential Detection
// ---------------------------------------------------------------------------

export interface GitHubEnvCredential {
  readonly token: string
  /** The variable the token came from (e.g. GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, MYAPP_GH_TOKEN). */
  readonly envVar: string
  /**
   * both-set-and-differ visibility: set to the LOSING variable when both
   * GITHUB_TOKEN and GH_TOKEN are set with different values, so the UI can
   * surface "GH_TOKEN is also set and differs; Runbooks used GITHUB_TOKEN —
   * gh would use GH_TOKEN." (we keep the golang-tested GITHUB_TOKEN > GH_TOKEN
   * order; gh itself prefers GH_TOKEN).
   */
  readonly shadowedVar?: string
}

/** The github.com / ghe.com token vars, in Runbooks' (golang-parity) order. */
export const GITHUB_TOKEN_ENV_VARS = ["GITHUB_TOKEN", "GH_TOKEN"] as const

/** The GHES token vars, in gh's own precedence order. */
export const GITHUB_ENTERPRISE_TOKEN_ENV_VARS = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const

/** A blank env var counts as unset (as in gh). */
const isSetEnvVar = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0

/** `<prefix>GH_HOST`, raw and unnormalized; blank counts as unset. */
export const configuredGhHost = (
  env: Record<string, string | undefined>,
  prefix = "",
): string | undefined => {
  const value = env[`${prefix}GH_HOST`]
  return isSetEnvVar(value) ? value : undefined
}

/**
 * The host gh's env conventions bind each env token to — each token goes to
 * exactly ONE host and is never transmitted anywhere else:
 *
 *   - GITHUB_TOKEN / GH_TOKEN → GH_HOST when it names github.com or a
 *     `*.ghe.com` tenant, otherwise github.com. (gh sends these to github.com
 *     AND ghe.com hosts; Runbooks is stricter: one host, so a github.com token
 *     never reaches a ghe.com tenant or the reverse.)
 *   - GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN → GH_HOST when it names a
 *     GHES host, otherwise nowhere. (gh sends these to ANY GHES host; a
 *     runbook-authored `host` could then harvest them, so the binding pins
 *     them to the host the user chose.)
 *
 * A GH_HOST that is set but unparseable binds NOTHING — falling back to
 * github.com would send a corporate token cross-origin on a typo.
 *
 * Prefixed tokens (the `{env:{prefix}}` variant) are bound the same way by
 * `<PREFIX>GH_HOST` — never by the unprefixed GH_HOST (as for GitLab's
 * prefixed host vars).
 */
export interface GitHubEnvBindings {
  readonly standard?: string
  readonly enterprise?: string
}

export const githubEnvBindings = (
  env: Record<string, string | undefined>,
  prefix = "",
): GitHubEnvBindings => {
  const raw = configuredGhHost(env, prefix)
  if (raw === undefined) return { standard: DEFAULT_GITHUB_HOST }
  const ghHost = tryNormalizeGitHubHost(raw)
  if (!ghHost) return {}
  return githubHostKind(ghHost) === "ghes"
    ? { standard: DEFAULT_GITHUB_HOST, enterprise: ghHost }
    : { standard: ghHost }
}

/**
 * The env var names that may supply a token for `host` (prefixed for the
 * `{env:{prefix}}` variant), in precedence order — empty when no env token
 * is bound to `host`. The prefix MUST already be allowlist-validated
 * (ENV_PREFIX_PATTERN) by the caller; an invalid one yields no names.
 */
export const githubEnvTokenVarsForHost = (
  host: string,
  env: Record<string, string | undefined>,
  prefix = "",
): string[] => {
  if (prefix !== "" && !ENV_PREFIX_PATTERN.test(prefix)) return []
  const target = tryNormalizeGitHubHost(host)
  if (!target) return []
  const bindings = githubEnvBindings(env, prefix)
  const names =
    bindings.standard === target
      ? GITHUB_TOKEN_ENV_VARS
      : bindings.enterprise === target
        ? GITHUB_ENTERPRISE_TOKEN_ENV_VARS
        : []
  return names.map((name) => `${prefix}${name}`)
}

/**
 * Pure env read: the token bound to `host` in an env record, with its source
 * var. Used for the ambient env (detectEnvCredentials) and for any other env
 * record interpreted with gh's conventions (the session env, the CLI test
 * executor).
 */
export const githubEnvCredentialForHost = (
  host: string,
  env: Record<string, string | undefined>,
  prefix = "",
): GitHubEnvCredential | undefined => {
  const names = githubEnvTokenVarsForHost(host, env, prefix)
  const index = names.findIndex((name) => isSetEnvVar(env[name]))
  if (index === -1) return undefined
  const envVar = names[index]
  const token = env[envVar] as string
  // The GITHUB_TOKEN-vs-GH_TOKEN divergence hint is for the unprefixed
  // github.com-family pair only (the enterprise pair follows gh's own order).
  const loser = names[index + 1]
  const shadowed =
    prefix === "" && envVar === "GITHUB_TOKEN" && loser === "GH_TOKEN" &&
    isSetEnvVar(env[loser]) && env[loser] !== token
      ? loser
      : undefined
  return { token, envVar, ...(shadowed ? { shadowedVar: shadowed } : {}) }
}

/**
 * The session env vars a GitHub auth block writes for a credential validated
 * against `host`: GITHUB_TOKEN / GITHUB_USER (the block's documented
 * outputs), GITHUB_HOST (which host they belong to), and GH_HOST so a `gh`
 * command in a later script targets the same host. For a GHES host the token
 * is also written as GH_ENTERPRISE_TOKEN — the only token var gh reads for
 * GHES.
 */
export const githubSessionEnv = (
  host: string,
  token: string,
  login?: string,
): Record<string, string> => ({
  GITHUB_TOKEN: token,
  ...(login ? { GITHUB_USER: login } : {}),
  GITHUB_HOST: host,
  GH_HOST: host,
  ...(githubHostKind(host) === "ghes" ? { GH_ENTERPRISE_TOKEN: token } : {}),
})

/**
 * Host-bound read of the GitHub credential in the session env.
 *
 * `authHost` is the host a GitAuth block wrote the session credential for
 * (main-only bookkeeping). It is trusted only while the env still carries the
 * matching GITHUB_HOST the block wrote with it — a session env reset drops
 * both together. With it, the session's GITHUB_TOKEN (or GH_TOKEN) is
 * released for that host and no other. Without it, the session env is
 * whatever the process started with, so it is interpreted with gh's own
 * conventions (githubEnvBindings) exactly like the ambient env.
 *
 * `host` undefined means "the session's GitHub host": the auth block's host,
 * else the host an env token is bound to (standard first, then enterprise),
 * else github.com.
 */
export const githubSessionCredential = (
  env: Record<string, string | undefined>,
  host: string | undefined,
  authHost?: string,
): { token: string; host: string } | undefined => {
  const boundAuthHost =
    authHost !== undefined && tryNormalizeGitHubHost(env.GITHUB_HOST) === authHost ? authHost : undefined
  const bindings = githubEnvBindings(env)
  const target =
    host !== undefined
      ? tryNormalizeGitHubHost(host)
      : (boundAuthHost ??
        [bindings.standard, bindings.enterprise].find(
          (h) => h !== undefined && githubEnvCredentialForHost(h, env) !== undefined,
        ) ??
        DEFAULT_GITHUB_HOST)
  if (!target) return undefined
  if (boundAuthHost !== undefined) {
    if (target !== boundAuthHost) return undefined
    const token = [env.GITHUB_TOKEN, env.GH_TOKEN].find(isSetEnvVar)
    return token ? { token, host: target } : undefined
  }
  const cred = githubEnvCredentialForHost(target, env)
  return cred ? { token: cred.token, host: target } : undefined
}

/**
 * Detect a GitHub token for `host` (default github.com) from environment
 * variables, per the gh-convention host binding above: GITHUB_TOKEN then
 * GH_TOKEN (golang-parity order, beta-v0.9.0 api/remote_token_test.go) for
 * the standard-bound host; GH_ENTERPRISE_TOKEN then GITHUB_ENTERPRISE_TOKEN
 * for the GHES host GH_HOST names.
 *
 * With a `prefix` (the `{env:{prefix}}` variant), looks up the same names
 * with the prefix (`<PREFIX>GITHUB_TOKEN`, …), bound by `<PREFIX>GH_HOST`.
 */
export const detectEnvCredentials = (host: string = DEFAULT_GITHUB_HOST, prefix?: string) =>
  Effect.gen(function* () {
    const env = yield* Environment
    return githubEnvCredentialForHost(host, yield* env.getAll(), prefix ?? "")
  })

/**
 * `gh auth token --hostname <host>` (default github.com): the pin neutralizes
 * GH_HOST and multi-host gh configs, so gh returns the token stored for
 * exactly this host; hygiene env via GH_ENV_OVERRIDES. Covers keyring storage
 * (gh ≥ 2.26.0). Undefined when gh is missing, unauthenticated for the host,
 * or times out.
 */
export const detectCliCredentials = (host: string = DEFAULT_GITHUB_HOST) =>
  detectCliToken(
    "gh",
    ["auth", "token", "--hostname", host],
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
 * `gh auth status --hostname <host>`: fine-grained PATs have no
 * X-OAuth-Scopes header, but gh knows its own token's scopes. Output goes to
 * either stream depending on gh version, so both are parsed (golang used
 * CombinedOutput). Failures are ignored — scopes are advisory enrichment.
 */
export const cliScopes = (host: string = DEFAULT_GITHUB_HOST) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const environment = yield* Environment

    const result = yield* Effect.either(
      Effect.gen(function* () {
        const childEnv = buildCliEnv(yield* environment.getAll(), GH_ENV_OVERRIDES)
        const proc = yield* spawner.spawn(
          "gh",
          ["auth", "status", "--hostname", host],
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
// gh hosts.yml (binary-absent-only fallback)
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
  /** The host's oauth_token, when present on disk. */
  readonly token?: string
  /**
   * Whether a hosts.yml entry for the host exists at all. True with no token
   * means gh keyring storage — the caller surfaces "gh stores this token in
   * the OS keyring; install gh or paste a token."
   */
  readonly entryExists: boolean
}

interface GhHostEntry {
  oauth_token?: unknown
  user?: unknown
  users?: Record<string, { oauth_token?: unknown } | null | undefined> | null
}

const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const parseGhHostsYaml = (yamlContent: string): Record<string, GhHostEntry | null | undefined> | undefined => {
  try {
    const parsed = YAML.parse(yamlContent, { logLevel: "silent" }) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, GhHostEntry | null | undefined>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse every host gh is logged into from hosts.yml content — one top-level
 * key per host (github.com, a GHES host, a ghe.com tenant). Keys are
 * normalized (lowercased); a key that isn't a parseable host is skipped.
 * Exported for testing.
 */
export function parseGhHosts(yamlContent: string): string[] {
  const parsed = parseGhHostsYaml(yamlContent)
  if (!parsed) return []
  const hosts = new Set<string>()
  for (const key of Object.keys(parsed)) {
    const host = tryNormalizeGitHubHost(key)
    if (host) hosts.add(host)
  }
  return [...hosts]
}

/**
 * Parse `host`'s oauth_token (default github.com) from hosts.yml content.
 * The active account's token lives at `<host>.oauth_token`; gh ≥ 2.40's
 * multi-account layout may instead keep it under `<host>.users.<user>`, which
 * is read as a fallback for the active `user`. Exported for testing.
 */
export function parseGhHostsToken(
  yamlContent: string,
  host: string = DEFAULT_GITHUB_HOST,
): GhHostsYmlResult {
  const parsed = parseGhHostsYaml(yamlContent)
  const target = tryNormalizeGitHubHost(host)
  if (!parsed || !target) return { entryExists: false }
  const key = Object.keys(parsed).find((k) => tryNormalizeGitHubHost(k) === target)
  if (key === undefined) return { entryExists: false }
  const entry = parsed[key]
  if (!entry || typeof entry !== "object") return { entryExists: true }
  const user = nonBlank(entry.user)
  const token =
    nonBlank(entry.oauth_token) ??
    (user && entry.users && typeof entry.users === "object"
      ? nonBlank(entry.users[user]?.oauth_token)
      : undefined)
  return { entryExists: true, ...(token ? { token } : {}) }
}

/** Read gh's hosts.yml (empty string when absent/unreadable). */
const readGhHostsYml = () =>
  Effect.gen(function* () {
    const env = yield* Environment
    const fs = yield* FileSystem
    const path = resolveGhHostsPath({ env: yield* env.getAll() })
    if (!path) return ""
    return yield* fs.readFile(path).pipe(Effect.orElseSucceed(() => ""))
  })

/**
 * Direct hosts.yml parse for `host` (default github.com) — the
 * gh-BINARY-ABSENT-ONLY fallback. Callers must gate on "gh is not installed":
 * when the binary is present, `gh auth token --hostname` is authoritative
 * (keyring, token rotation).
 */
export const detectHostsYmlCredentials = (host: string = DEFAULT_GITHUB_HOST) =>
  readGhHostsYml().pipe(
    Effect.map((content): GhHostsYmlResult =>
      content ? parseGhHostsToken(content, host) : { entryExists: false },
    ),
  )

/**
 * The hosts gh is logged into, from hosts.yml (no subprocess, no network).
 * Drives the GitAuth host picker and GitHub provider detection.
 */
export const detectGhConfigHosts = () =>
  readGhHostsYml().pipe(Effect.map((content) => (content ? parseGhHosts(content) : [])))

// ---------------------------------------------------------------------------
// GitHub API Queries
// ---------------------------------------------------------------------------

/**
 * List organizations the authenticated user belongs to.
 */
export const listOrgs = (token: string, host?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listOrgs(token, host)
  })

/**
 * List repositories for an organization, with optional name filter.
 */
export const listRepos = (token: string, org: string, query?: string, host?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listRepos(token, org, query, host)
  })

/**
 * Fetch a single repository by owner/name, including immutable numeric IDs.
 */
export const getRepo = (token: string, owner: string, repo: string, host?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.getRepo(token, owner, repo, host)
  })

/**
 * List refs (branches and tags) for a repository, with optional filter.
 */
export const listRefs = (
  token: string,
  owner: string,
  repo: string,
  query?: string,
  host?: string,
) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listRefs(token, owner, repo, query, host)
  })

/**
 * List labels defined on a repository.
 */
export const listLabels = (token: string, owner: string, repo: string, host?: string) =>
  Effect.gen(function* () {
    const ghClient = yield* GitHubClient
    return yield* ghClient.listLabels(token, owner, repo, host)
  })
