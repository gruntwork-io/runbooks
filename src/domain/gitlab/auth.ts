/**
 * GitLab authentication logic.
 *
 * Mirrors src/domain/github/auth.ts, but uses the `glab` CLI and the
 * GITLAB_TOKEN environment variable. GitLab has no OAuth device flow here (no
 * registered Gruntwork GitLab app), so authentication is PAT / CLI / env only.
 */
import { Effect, Stream } from "effect"
import YAML from "yaml"
import { join } from "node:path"
import { GitLabClient } from "../../services/GitLabClient.ts"
import type { GitLabTokenType } from "../../services/GitLabClient.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"
import { FileSystem } from "../../services/FileSystem.ts"

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

// ---------------------------------------------------------------------------
// glab CLI config file (config.yml)
// ---------------------------------------------------------------------------

/**
 * The GitLab host this app authenticates against. The HTTP client targets
 * gitlab.com only, so we read the gitlab.com credentials out of glab's config
 * regardless of which host glab itself defaults to.
 */
const GITLAB_HOST = "gitlab.com"

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
 * We probe each in order and use the first file that exists and holds a token,
 * which reproduces glab's precedence (it picks the first directory that
 * contains a config.yml). Exported for testing.
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
  host?: string
  hosts?: Record<string, { token?: unknown } | undefined>
}

/**
 * Extract the gitlab.com access token from glab `config.yml` contents.
 *
 * glab obfuscates stored secrets by tagging them as `!!null`
 * (e.g. `token: !!null glpat-...`), which makes a naive YAML load return null.
 * We strip that tag before parsing so the value survives. OAuth logins store an
 * opaque access token here (no `glpat-` prefix); token logins store the PAT.
 *
 * Exported for testing.
 */
export function parseGlabToken(yamlContent: string): string | undefined {
  // Strip glab's `!!null ` secret tag so the scalar parses as its string value.
  const cleaned = yamlContent.replace(/!!null\s+/g, "")

  let token: unknown
  try {
    const parsed = YAML.parse(cleaned, { logLevel: "silent" }) as GlabConfig | null
    token = parsed?.hosts?.[GITLAB_HOST]?.token
  } catch {
    return undefined
  }

  if (typeof token === "string" && token.trim().length > 0) {
    return token.trim()
  }

  return undefined
}

/**
 * Detect a GitLab token from glab's CLI config file (`config.yml`).
 *
 * `glab auth login` does not export an environment variable; it writes the
 * token into glab's `config.yml`. This reads that file directly, which also
 * works when the `glab` binary is not on PATH (common inside Electron's spawn
 * environment, where `glab auth token` would fail to launch). Returns undefined
 * if no config file or gitlab.com token is found.
 */
export const detectConfigCredentials = () =>
  Effect.gen(function* () {
    const env = yield* Environment
    const fs = yield* FileSystem

    const allEnv = yield* env.getAll()
    const candidates = resolveGlabConfigPaths({
      env: allEnv,
      platform: process.platform,
    })

    for (const path of candidates) {
      const exists = yield* fs.exists(path)
      if (!exists) continue

      const content = yield* fs
        .readFile(path)
        .pipe(Effect.orElseSucceed(() => ""))
      const token = parseGlabToken(content)
      if (token) return token
    }

    return undefined
  })
