/**
 * GitLab authentication logic.
 *
 * Mirrors src/domain/github/auth.ts, but uses the `glab` CLI and the
 * GITLAB_TOKEN environment variable. GitLab has no OAuth device flow here (no
 * registered Gruntwork GitLab app), so authentication is PAT / CLI / env only.
 */
import { Effect } from "effect"
import YAML from "yaml"
import { join } from "node:path"
import { GitLabClient } from "../../services/GitLabClient.ts"
import type { GitLabTokenType } from "../../services/GitLabClient.ts"
import { Environment } from "../../services/Environment.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { detectCliToken } from "../git/cli-token.ts"

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
 *
 * `baseUrl` is the instance origin (e.g. `https://gitlab.example.com`) so a
 * self-hosted token validates against its own instance; defaults to gitlab.com.
 */
export const validateToken = (token: string, baseUrl?: string) =>
  Effect.gen(function* () {
    const glClient = yield* GitLabClient
    return yield* glClient.validateToken(token, baseUrl)
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
  detectCliToken("glab", ["auth", "token"], GLAB_CLI_TIMEOUT_MS)

// ---------------------------------------------------------------------------
// glab CLI config file (config.yml)
// ---------------------------------------------------------------------------

/**
 * The GitLab host used when a caller does not name one. The renderer resolves
 * an explicit host (an authored `host` prop, the user's pick from the host
 * picker, or a manually-entered instance URL) and threads it through; this is
 * only the fallback for single-host setups and backward compatibility. glab's
 * config.yml stores tokens per host (`hosts: { <host>: ... }`), so a self-hosted
 * instance is read by passing its host instead.
 */
export const DEFAULT_GITLAB_HOST = "gitlab.com"

/**
 * Whether the host-agnostic env `GITLAB_TOKEN` may be auto-validated against
 * `host` during on-mount detection. Restricted to gitlab.com and hosts the user
 * has actually logged into via glab, so an authored `host`/`instanceUrl` prop
 * can't silently exfiltrate the env token to an arbitrary origin with no user
 * interaction. Any other host must go through the explicit PAT flow.
 */
export const isEnvTokenHostAllowed = (
  host: string,
  configHosts: readonly string[],
): boolean => host === DEFAULT_GITLAB_HOST || configHosts.includes(host)

/**
 * Resolve the candidate paths to glab's `config.yml`, in glab's own lookup
 * order. glab (gitlab-org/cli, `internal/config/config_file.go`) resolves its
 * config directory via the `adrg/xdg` library as:
 *
 *   1. $GLAB_CONFIG_DIR
 *   2. ~/.config/glab-cli              (legacy location, checked for backward
 *                                       compatibility BEFORE the XDG default on
 *                                       every platform — only used if present)
 *   3. xdg.ConfigHome/glab-cli, where xdg.ConfigHome is:
 *        $XDG_CONFIG_HOME              (honored on every platform if set)
 *        macOS:   ~/Library/Application Support
 *        Windows: %LOCALAPPDATA%       (fallback ~/AppData/Local)
 *        Linux:   ~/.config            (same as the legacy location)
 *
 * We probe these in glab's directory-precedence order and return the first
 * config that holds a token for the requested host. (glab itself uses the first
 * directory whose config.yml exists; we instead skip a config that lacks the
 * requested host's token, since our goal is to surface a usable credential the
 * user already has.)
 * Exported for testing.
 */
export function resolveGlabConfigPaths(opts: {
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
}): string[] {
  const { env, platform } = opts
  const home = env.HOME || env.USERPROFILE || ""
  const paths: string[] = []

  const add = (...segments: string[]) => {
    if (segments.every((s) => s.length > 0)) {
      paths.push(join(...segments))
    }
  }

  // 1. Explicit override.
  if (env.GLAB_CONFIG_DIR) add(env.GLAB_CONFIG_DIR, "config.yml")
  // 2. Legacy ~/.config/glab-cli — glab checks this before the platform default
  //    and before $XDG_CONFIG_HOME, for backward compatibility.
  add(home, ".config", "glab-cli", "config.yml")
  // 3a. $XDG_CONFIG_HOME (adrg/xdg honors it on every platform).
  if (env.XDG_CONFIG_HOME) add(env.XDG_CONFIG_HOME, "glab-cli", "config.yml")
  // 3b. Platform default config home.
  if (platform === "darwin") {
    add(home, "Library", "Application Support", "glab-cli", "config.yml")
  } else if (platform === "win32") {
    add(env.LOCALAPPDATA ?? "", "glab-cli", "config.yml")
    add(home, "AppData", "Local", "glab-cli", "config.yml")
  }
  // (Linux's platform default is ~/.config, already added at step 2.)

  // De-dupe while preserving order.
  return paths.filter((p, i) => paths.indexOf(p) === i)
}

interface GlabConfig {
  /** glab's top-level default host (the `host:` key in config.yml). */
  host?: unknown
  hosts?: Record<string, { token?: unknown } | undefined>
}

/**
 * Extract a host's access token from glab `config.yml` contents. `host`
 * defaults to gitlab.com; pass a self-hosted host to read its credentials.
 *
 * glab obfuscates stored secrets by tagging them as `!!null`
 * (e.g. `token: !!null glpat-...`), which makes a naive YAML load return null.
 * We strip that tag before parsing so the value survives. OAuth logins store an
 * opaque access token here (no `glpat-` prefix); token logins store the PAT.
 *
 * `host` selects which entry under `hosts:` to read (defaults to gitlab.com),
 * so a user logged into several GitLab instances can surface the right one.
 *
 * Exported for testing.
 */
export function parseGlabToken(
  yamlContent: string,
  host: string = DEFAULT_GITLAB_HOST,
): string | undefined {
  // Strip glab's `!!null ` secret tag so the scalar parses as its string value.
  const cleaned = yamlContent.replace(/!!null\s+/g, "")

  let token: unknown
  try {
    const parsed = YAML.parse(cleaned, { logLevel: "silent" }) as GlabConfig | null
    token = parsed?.hosts?.[host]?.token
  } catch {
    return undefined
  }

  if (typeof token === "string" && token.trim().length > 0) {
    return token.trim()
  }

  return undefined
}

export interface GlabHostsInfo {
  /** Every host key present under `hosts:` in glab's config. */
  readonly hosts: string[]
  /**
   * glab's configured default host (the top-level `host:` field) when it is one
   * of the enumerated hosts; otherwise the first host, or gitlab.com when none.
   */
  readonly defaultHost: string
}

/**
 * Enumerate the GitLab hosts a glab `config.yml` defines, plus glab's default
 * host. Used to drive the GitAuth host picker when the user is logged into more
 * than one instance (e.g. gitlab.com and a self-hosted gitlab.example.com).
 *
 * Exported for testing.
 */
export function enumerateGlabHosts(yamlContent: string): GlabHostsInfo {
  const cleaned = yamlContent.replace(/!!null\s+/g, "")
  try {
    const parsed = YAML.parse(cleaned, { logLevel: "silent" }) as GlabConfig | null
    const hosts = Object.keys(parsed?.hosts ?? {})
    const declared = typeof parsed?.host === "string" ? parsed.host : undefined
    const defaultHost =
      declared && hosts.includes(declared)
        ? declared
        : (hosts[0] ?? DEFAULT_GITLAB_HOST)
    return { hosts, defaultHost }
  } catch {
    return { hosts: [], defaultHost: DEFAULT_GITLAB_HOST }
  }
}

/**
 * Detect a GitLab token from glab's CLI config file (`config.yml`).
 *
 * `glab auth login` does not export an environment variable; it writes the
 * token into glab's `config.yml`. This reads that file directly, so detection
 * still works when `glab auth token` yields nothing — e.g. the `glab` binary is
 * not on PATH (common inside Electron's spawn environment), or `glab auth token`
 * cannot disambiguate which host to use when several are configured. `host`
 * selects the instance (defaults to gitlab.com). Returns undefined if no config
 * file or token for that host is found.
 */
export const detectConfigCredentials = (host: string = DEFAULT_GITLAB_HOST) =>
  Effect.gen(function* () {
    const env = yield* Environment
    const fs = yield* FileSystem

    const allEnv = yield* env.getAll()
    const candidates = resolveGlabConfigPaths({
      env: allEnv,
      platform: process.platform,
    })

    for (const path of candidates) {
      // readFile already falls back to "" for a missing/unreadable file, so no
      // separate existence check is needed.
      const content = yield* fs
        .readFile(path)
        .pipe(Effect.orElseSucceed(() => ""))
      const token = parseGlabToken(content, host)
      if (token) return token
    }

    return undefined
  })

/**
 * Enumerate the GitLab hosts the user is logged into via glab, reading the
 * first glab `config.yml` (in glab's directory-precedence order) that defines
 * any hosts. Returns an empty list and the gitlab.com default when no glab
 * config is present. Powers the GitAuth host picker.
 */
export const detectConfigHosts = () =>
  Effect.gen(function* () {
    const env = yield* Environment
    const fs = yield* FileSystem

    const allEnv = yield* env.getAll()
    const candidates = resolveGlabConfigPaths({
      env: allEnv,
      platform: process.platform,
    })

    for (const path of candidates) {
      const content = yield* fs
        .readFile(path)
        .pipe(Effect.orElseSucceed(() => ""))
      const info = enumerateGlabHosts(content)
      if (info.hosts.length > 0) return info
    }

    return { hosts: [] as string[], defaultHost: DEFAULT_GITLAB_HOST }
  })
