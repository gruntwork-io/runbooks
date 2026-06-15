/**
 * GitLab authentication logic.
 *
 * Mirrors src/domain/github/auth.ts, but uses the `glab` CLI and the GitLab
 * token environment variables. GitLab has no OAuth device flow here (no
 * registered Gruntwork GitLab app), so authentication is PAT / CLI / env only.
 *
 * CLI reads are PER HOST: `glab config get token --host <H>` —
 * glab has no `auth token` subcommand.
 */
import { Effect, Stream } from "effect"
import YAML from "yaml"
import { join } from "node:path"
import { GitLabClient } from "../../services/GitLabClient.ts"
import type { GitLabTokenType } from "../../services/GitLabClient.ts"
import { Environment } from "../../services/Environment.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { buildCliEnv } from "../git/cli-token.ts"
import type { CliEnvOverrides } from "../git/cli-token.ts"
import { normalizeGitLabHost, tryNormalizeGitLabHost } from "../git/gitlab-host.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout in milliseconds for `glab config get token` (local read). */
const GLAB_CLI_TIMEOUT_MS = 5_000

/** Timeout for `glab auth status` (network call, used for OAuth refresh). */
const GLAB_STATUS_TIMEOUT_MS = 10_000

/** Refresh an OAuth token that expires within this window. */
const OAUTH_STALENESS_MARGIN_MS = 60_000

/**
 * glab's documented token env vars, in glab's own precedence order
 * (OAUTH_TOKEN is a real, glab-honored legacy credential).
 */
export const GITLAB_TOKEN_ENV_VARS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] as const

/** glab treats an empty/blank env var as unset. */
const isSetEnvVar = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0

/**
 * OFFLINE check: whether any of glab's token env vars is set (blank counts as
 * unset). Truthiness, not ??: an empty GITLAB_TOKEN must not hide a real
 * GITLAB_ACCESS_TOKEN.
 */
export const hasEnvToken = (env: Record<string, string | undefined>): boolean =>
  GITLAB_TOKEN_ENV_VARS.some((envVar) => isSetEnvVar(env[envVar]))

/**
 * Child-env hygiene for every glab spawn: strip the ambient token vars
 * (they override per-host reads INSIDE glab, so leaving them would echo the
 * env source — and could leak an env token to the wrong host); kill update
 * checks, telemetry, prompts, and color. `NO_PROMPT` is stripped, never set:
 * it is deprecated in glab, and setting it makes glab print a warning ON
 * STDOUT ahead of every payload we parse. All spawns are non-interactive with
 * timeouts, so a prompt or update check can never hang a read regardless.
 */
export const GLAB_ENV_OVERRIDES: CliEnvOverrides = {
  unset: [...GITLAB_TOKEN_ENV_VARS, "NO_PROMPT"],
  set: {
    GLAB_CHECK_UPDATE: "false",
    GLAB_SEND_TELEMETRY: "false",
    GLAB_NO_PROMPT: "true",
    NO_COLOR: "1",
  },
}

// ---------------------------------------------------------------------------
// Per-host spawn serialization
// ---------------------------------------------------------------------------

// glab rewrites config.yml with no file locking, and the OAuth staleness path
// deliberately triggers such a rewrite (`glab auth status`). Serializing OUR
// spawns per host guarantees we never race glab's rewrite against our own
// re-read. (A user-run glab in a terminal can still race it — accepted.)
const glabHostSemaphores = new Map<string, Effect.Semaphore>()

const glabSemaphoreFor = (host: string): Effect.Semaphore => {
  let semaphore = glabHostSemaphores.get(host)
  if (!semaphore) {
    semaphore = Effect.unsafeMakeSemaphore(1)
    glabHostSemaphores.set(host, semaphore)
  }
  return semaphore
}

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

export interface GitLabEnvCredential {
  readonly token: string
  /** The variable the token came from (glab's documented precedence order). */
  readonly envVar: (typeof GITLAB_TOKEN_ENV_VARS)[number]
}

/**
 * Detect a GitLab token from environment variables, in glab's own documented
 * precedence: GITLAB_TOKEN, then GITLAB_ACCESS_TOKEN, then OAUTH_TOKEN
 * (OAUTH_TOKEN is a real, glab-honored legacy credential). Returns
 * undefined when none is set.
 */
export const detectEnvCredentials = () =>
  Effect.gen(function* () {
    const env = yield* Environment

    for (const envVar of GITLAB_TOKEN_ENV_VARS) {
      const token = yield* env.get(envVar)
      if (token) {
        return { token, envVar } satisfies GitLabEnvCredential
      }
    }

    return undefined
  })

// ---------------------------------------------------------------------------
// Per-host glab CLI read (source #2) — the three exit contracts
// ---------------------------------------------------------------------------

export type GlabCliRead =
  /** Contract (a): exit 0 + token on stdout. */
  | { readonly kind: "token"; readonly token: string }
  /** Contract (b): exit 0 + empty stdout — host not configured, never an error.
   *  Also any unknown failure mode (timeout, unexpected exit): degrades to
   *  absent + manual paste, never breakage. */
  | { readonly kind: "absent" }
  /** Contract (c): exit 1 + stderr `not found in keyring` — glab IS installed
   *  but the OS keyring is locked/unreadable. Distinct copy, never "install glab". */
  | { readonly kind: "keyring-blocked" }
  /** Spawn ENOENT — the glab binary is missing. Gates the config.yml fallback
   *  (source #3 is BINARY-ABSENT-ONLY). */
  | { readonly kind: "not-installed" }
  /** OAuth token was stale and the glab-delegated refresh failed. */
  | { readonly kind: "oauth-stale" }

interface GlabRunResult {
  readonly exitCode: number
  readonly stdout: string[]
  readonly stderr: string[]
}

/** Spawn glab with hygiene env (plus optional extra vars — e.g. the
 *  probe's candidate-token injection), collecting both streams. Fails on
 *  spawn error. */
const runGlab = (
  args: string[],
  timeoutMs: number,
  setEnv?: Record<string, string>,
): Effect.Effect<GlabRunResult, unknown, ProcessSpawner | Environment> =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const environment = yield* Environment
    const childEnv = {
      ...buildCliEnv(yield* environment.getAll(), GLAB_ENV_OVERRIDES),
      ...setEnv,
    }
    const proc = yield* spawner.spawn("glab", args, { env: childEnv })
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* proc.output.pipe(
          Stream.runForEach((line) =>
            Effect.sync(() => {
              ;(line.source === "stdout" ? stdout : stderr).push(line.line)
            }),
          ),
          Effect.timeout(timeoutMs),
        )
        return yield* proc.exitCode.pipe(Effect.timeout(timeoutMs))
      }),
      proc.kill.pipe(Effect.ignore),
    )
    return { exitCode, stdout, stderr }
  })

export const isSpawnEnoent = (err: unknown): boolean => {
  // SpawnError carries the raw cause; ENOENT shows up either as the Node
  // errno code on the cause or in its message.
  const cause = (err as { cause?: unknown })?.cause
  const code = (cause as { code?: unknown })?.code
  if (code === "ENOENT") return true
  return `${cause ?? err}`.includes("ENOENT")
}

/**
 * Per-host glab token read: `glab config get token --host <H>`,
 * 5s timeout, hygiene env, serialized through the per-host semaphore. Maps
 * the three pinned exit contracts; every unknown failure mode degrades to
 * absent (manual paste path), never breakage. No network; parallel-safe
 * across hosts. Covers keyring-stored tokens (glab's config layer reads the
 * keyring on `config get token`).
 */
export const detectCliCredentialsForHost = (
  host: string,
): Effect.Effect<GlabCliRead, never, ProcessSpawner | Environment> =>
  glabSemaphoreFor(host).withPermits(1)(readTokenRun(host))

/** The unsynchronized core read — callers hold the per-host permit. */
const readTokenRun = (
  host: string,
): Effect.Effect<GlabCliRead, never, ProcessSpawner | Environment> =>
  Effect.gen(function* () {
    const result = yield* Effect.either(
      runGlab(["config", "get", "token", "--host", host], GLAB_CLI_TIMEOUT_MS),
    )
    if (result._tag === "Left") {
      return isSpawnEnoent(result.left)
        ? ({ kind: "not-installed" } as const)
        : ({ kind: "absent" } as const)
    }
    const { exitCode, stdout, stderr } = result.right
    const token = stdout.map((line) => line.trim()).find((line) => line.length > 0)
    if (exitCode === 0) {
      // Contract (a) token / contract (b) empty-stdout = host not configured.
      return token ? ({ kind: "token", token } as const) : ({ kind: "absent" } as const)
    }
    if (exitCode === 1 && stderr.some((line) => line.includes("not found in keyring"))) {
      return { kind: "keyring-blocked" } as const
    }
    return { kind: "absent" } as const
  })

/**
 * Outcome of a `glab auth status --hostname H` run, disambiguated by stderr
 * text: `No token found (checked config file, keyring, and
 * environment variables)` = not-logged-in vs `API call failed: …` =
 * instance/transport problem — never conflated in error copy.
 */
export type GlabAuthStatus = "ok" | "not-logged-in" | "api-failed" | "error"

const classifyGlabAuthStatus = (result: GlabRunResult): GlabAuthStatus => {
  if (result.exitCode === 0) return "ok"
  const stderr = result.stderr.join("\n")
  if (stderr.includes("No token found")) return "not-logged-in"
  if (stderr.includes("API call failed")) return "api-failed"
  return "error"
}

/**
 * Run `glab auth status --hostname <H>` (10s timeout, all output on stderr —
 * a network call). Used both as the OAuth-refresh SIDE EFFECT (glab
 * refreshes a stale OAuth token and rewrites its config on this call) and as
 * the probe for glab-sourced OAuth-shaped tokens (no token env
 * injection, so the PRIVATE-TOKEN header mismatch never arises).
 */
const authStatusRun = (host: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.either(
      runGlab(["auth", "status", "--hostname", host], GLAB_STATUS_TIMEOUT_MS),
    )
    if (result._tag === "Left") return "error" as const
    return classifyGlabAuthStatus(result.right)
  })

/** `glab auth status` under the per-host semaphore. */
export const glabAuthStatusForHost = (
  host: string,
): Effect.Effect<GlabAuthStatus, never, ProcessSpawner | Environment> =>
  glabSemaphoreFor(host).withPermits(1)(authStatusRun(host))

/**
 * Run an arbitrary glab command for a host under the per-host semaphore with
 * the hygiene env (plus optional extra vars). Exposed for the
 * validation probe (`glab api user --hostname H` with the candidate token in
 * child env — never argv).
 */
export const runGlabForHost = (
  host: string,
  args: string[],
  timeoutMs: number,
  setEnv?: Record<string, string>,
): Effect.Effect<
  { exitCode: number; stdout: string[]; stderr: string[] },
  unknown,
  ProcessSpawner | Environment
> => glabSemaphoreFor(host).withPermits(1)(runGlab(args, timeoutMs, setEnv))

/**
 * The full source-#2 read: when the host's stored credential is a stale
 * OAuth token (expiring within 60s), run the glab-delegated refresh first,
 * then (re-)read the token. Both spawns hold the per-host semaphore so we
 * never race glab's config rewrite against our re-read. When the refresh
 * fails (or glab is missing), a stale token degrades to `oauth-stale` — the
 * caller surfaces the exact expired-token remediation.
 */
export const readGlabTokenForHost = (
  host: string,
  now: () => Date = () => new Date(),
): Effect.Effect<GlabCliRead, never, ProcessSpawner | Environment | FileSystem> =>
  Effect.gen(function* () {
    const meta = yield* detectHostMeta(host)
    const stale =
      meta?.isOAuth2 === true &&
      meta.oauth2ExpiryDate !== undefined &&
      meta.oauth2ExpiryDate.getTime() < now().getTime() + OAUTH_STALENESS_MARGIN_MS

    if (!stale) {
      return yield* detectCliCredentialsForHost(host)
    }

    // Hold the permit across refresh + re-read so the pair is atomic w.r.t.
    // our own spawns.
    return yield* glabSemaphoreFor(host).withPermits(1)(
      Effect.gen(function* () {
        const refreshed = (yield* authStatusRun(host)) === "ok"
        if (!refreshed) {
          return { kind: "oauth-stale" } as const
        }
        const read = yield* readTokenRun(host)
        // A post-refresh non-token read still means the remediation copy.
        return read.kind === "token" || read.kind === "not-installed"
          ? read
          : ({ kind: "oauth-stale" } as const)
      }),
    )
  })

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
 * binding: the env token is bound to exactly ONE host —
 * `normalize(GITLAB_HOST ?? GITLAB_URI ?? GL_HOST ?? "gitlab.com")` (glab's
 * own env precedence) — and the env source runs only for that host; it is
 * never transmitted anywhere else. Undefined (no binding at all) when a host
 * var is set but unparseable: falling back to gitlab.com would transmit a
 * corporate token cross-origin on a typo.
 */
export const envTokenHost = (
  env: Record<string, string | undefined>,
): string | undefined => {
  const configured = configuredEnvHost(env)
  if (configured === undefined) return DEFAULT_GITLAB_HOST
  return tryNormalizeGitLabHost(configured)
}

/**
 * glab's host env-var precedence (GITLAB_HOST, then GITLAB_URI, then GL_HOST),
 * raw and unnormalized; a blank var counts as unset.
 */
export const configuredEnvHost = (
  env: Record<string, string | undefined>,
): string | undefined => [env.GITLAB_HOST, env.GITLAB_URI, env.GL_HOST].find(isSetEnvVar)

/**
 * Whether the env token may be auto-validated against (i.e. transmitted to)
 * `host`: exactly when `host` IS the env token's bound host.
 */
export const mayAutoSendEnvToken = (
  host: string,
  env: Record<string, string | undefined>,
): boolean => {
  const bound = envTokenHost(env)
  return bound !== undefined && normalizeGitLabHost(host) === bound
}

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
  use_keyring?: unknown
}

/**
 * Parse glab `config.yml` contents tolerantly; null on any parse error. glab
 * obfuscates stored secrets by tagging them `!!null` (e.g. `token: !!null
 * glpat-...`), which makes a naive YAML load return null — strip the tag
 * first so the value survives.
 */
const parseGlabConfig = (yamlContent: string): GlabConfig | null => {
  try {
    return YAML.parse(yamlContent.replace(/!!null\s+/g, ""), {
      logLevel: "silent",
    }) as GlabConfig | null
  } catch {
    return null
  }
}

/**
 * Extract a host's access token from glab `config.yml` contents. `host`
 * selects which entry under `hosts:` to read (defaults to gitlab.com), so a
 * user logged into several GitLab instances can surface the right one. OAuth
 * logins store an opaque access token here (no `glpat-` prefix); token logins
 * store the PAT. Exported for testing.
 */
export function parseGlabToken(
  yamlContent: string,
  host: string = DEFAULT_GITLAB_HOST,
): string | undefined {
  const token = parseGlabConfig(yamlContent)?.hosts?.[host]?.token
  if (typeof token === "string" && token.trim().length > 0) {
    return token.trim()
  }
  return undefined
}

// ---------------------------------------------------------------------------
// glab per-host metadata (OAuth staleness + ca_cert harvest)
// ---------------------------------------------------------------------------

export interface GlabHostMeta {
  /** True when this host's stored credential is a glab OAuth2 login (2h expiry). */
  readonly isOAuth2: boolean
  /** Parsed oauth2_expiry_date, when present and parseable. */
  readonly oauth2ExpiryDate?: Date
  /** Per-host ca_cert PEM path (harvested into installSystemTrust). */
  readonly caCert?: string
  /** True when the host stores its token in the OS keyring (use_keyring). */
  readonly useKeyring: boolean
}

const asBool = (value: unknown): boolean =>
  value === true || (typeof value === "string" && value.trim().toLowerCase() === "true")

/**
 * Parse glab's Go-style time string ("2006-01-02 15:04:05.999999999 -0700
 * MST" — time.Time.String()) leniently: the trailing zone NAME is dropped
 * (the numeric offset is authoritative), fractional seconds are optional, and
 * plain RFC3339 also parses. Returns undefined for anything unparseable.
 * Exported for testing.
 */
export function parseGlabExpiry(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  const raw = value.trim()
  // Go default format → ISO-ish: "YYYY-MM-DD HH:MM:SS[.fff] ±HHMM [ZONE]"
  const goMatch = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*([+-]\d{2}):?(\d{2})?(?:\s+\S+)?$/,
  )
  const candidate = goMatch
    ? `${goMatch[1]}T${goMatch[2]}${goMatch[3]}:${goMatch[4] ?? "00"}`
    : raw
  const parsed = new Date(candidate)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * Read a host's auth metadata from glab config.yml contents: `is_oauth2`,
 * `oauth2_expiry_date`, `ca_cert`, `use_keyring` (host-level, falling back to
 * the top-level `use_keyring`). These are observed glab behavior, not stable
 * APIs — every read is tolerant. `skip_tls_verify` is deliberately
 * NEVER read: we never disable verification. Exported for testing.
 */
export function readGlabHostMeta(yamlContent: string, host: string): GlabHostMeta {
  return hostMetaFromConfig(parseGlabConfig(yamlContent), host)
}

const hostMetaFromConfig = (parsed: GlabConfig | null, host: string): GlabHostMeta => {
  const entry = (parsed?.hosts?.[host] ?? {}) as Record<string, unknown>
  return {
    isOAuth2: asBool(entry.is_oauth2),
    oauth2ExpiryDate: parseGlabExpiry(entry.oauth2_expiry_date),
    caCert:
      typeof entry.ca_cert === "string" && entry.ca_cert.trim().length > 0
        ? entry.ca_cert.trim()
        : undefined,
    useKeyring: asBool(entry.use_keyring) || asBool(parsed?.use_keyring),
  }
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
  const parsed = parseGlabConfig(yamlContent)
  const hosts = Object.keys(parsed?.hosts ?? {})
  const declared = typeof parsed?.host === "string" ? parsed.host : undefined
  const defaultHost =
    declared && hosts.includes(declared) ? declared : (hosts[0] ?? DEFAULT_GITLAB_HOST)
  return { hosts, defaultHost }
}

/**
 * Scan glab's candidate `config.yml` paths (in glab's directory-precedence
 * order) and return the first truthy result produced by `pick`. `readFile`
 * already falls back to "" for a missing/unreadable file, so no separate
 * existence check is needed. Returns undefined when no path yields a result.
 */
const scanGlabConfigs = <T>(pick: (content: string) => T | undefined) =>
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
      const picked = pick(content)
      if (picked) return picked
    }

    return undefined
  })

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
  scanGlabConfigs((content) => parseGlabToken(content, host))

/**
 * Enumerate the GitLab hosts the user is logged into via glab, reading the
 * first glab `config.yml` (in glab's directory-precedence order) that defines
 * any hosts. Returns an empty list and the gitlab.com default when no glab
 * config is present. Powers the GitAuth host picker.
 */
export const detectConfigHosts = () =>
  scanGlabConfigs((content) => {
    const info = enumerateGlabHosts(content)
    return info.hosts.length > 0 ? info : undefined
  }).pipe(
    Effect.map(
      (info) => info ?? { hosts: [] as string[], defaultHost: DEFAULT_GITLAB_HOST },
    ),
  )

/**
 * Read a host's glab metadata (is_oauth2 / oauth2_expiry_date / ca_cert /
 * use_keyring) from the first glab config that defines the host. Undefined
 * when no config defines it.
 */
export const detectHostMeta = (host: string) =>
  scanGlabConfigs((content) => {
    const parsed = parseGlabConfig(content)
    if (!parsed?.hosts || !(host in parsed.hosts)) return undefined
    return hostMetaFromConfig(parsed, host)
  })

/**
 * ca_cert harvest: collect the PEM CONTENTS of every per-host `ca_cert`
 * path in glab's config (first config with hosts, matching detectConfigHosts).
 * Unreadable files are skipped — the harvest is strictly best-effort and
 * strictly additive (fed into installSystemTrust as extraPems). Environments
 * where the CA exists only in a PEM referenced by glab config succeed
 * silently, with no error card and no subprocess transport.
 */
export const collectGlabCaCertPems = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const config = yield* scanGlabConfigs((content) => {
      const parsed = parseGlabConfig(content)
      const hosts = Object.keys(parsed?.hosts ?? {})
      return hosts.length > 0 ? { parsed, hosts } : undefined
    })
    if (!config) return [] as string[]

    const pems: string[] = []
    for (const host of config.hosts) {
      const caCertPath = hostMetaFromConfig(config.parsed, host).caCert
      if (!caCertPath) continue
      const pem = yield* fs.readFile(caCertPath).pipe(Effect.orElseSucceed(() => ""))
      if (pem.includes("-----BEGIN CERTIFICATE-----")) {
        pems.push(pem)
      }
    }
    return pems
  })
