/**
 * Resolve the Desktop-app OAuth client used by Google Sign-In.
 *
 * This is the *app* client (client_id / client_secret), not a user or
 * service-account credential. Resolution order:
 *   1. Author props `oauthClientId` + `oauthClientSecret`
 *   2. Author prop `oauthClientFile` (Google Console `client_secret_*.json`)
 *   3. Env `GOOGLE_OAUTH_CLIENT_CREDENTIALS` (path to the same JSON)
 *   4. Env `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET`
 *   5. Build defaults (`DEFAULT_GOOGLE_OAUTH_CLIENT_*`)
 *
 * File contents are read in MAIN only (FileSystem service) — the secret never
 * needs to cross into the renderer when a path is used.
 */
import { Effect } from "effect"
import { Environment } from "../../services/Environment.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { GoogleOAuthError } from "../../errors/index.ts"

/**
 * Gruntwork's registered Google Cloud "Desktop app" OAuth client. Mirrors
 * DEFAULT_GITHUB_OAUTH_CLIENT_ID (src/domain/github/auth.ts): main owns the
 * default, an author prop may override it.
 *
 * TODO(release): populate from the Gruntwork GCP project before shipping. While
 * empty, google:oauth-start returns
 * { error: "OAuth login is not configured for this build" } and the OAuth tab
 * renders disabled with that copy — unless the author or operator supplies a
 * client via props, a client JSON file, or env vars.
 */
export const DEFAULT_GOOGLE_OAUTH_CLIENT_ID = ""

/**
 * The client "secret" issued alongside the Desktop client. Per RFC 8252 an
 * installed-app secret is not confidential — it ships because Google issues one
 * with every Desktop client, not because it protects anything.
 */
export const DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET = ""

/** Env var holding a path to a Google Console Desktop-app client JSON. */
export const GOOGLE_OAUTH_CLIENT_CREDENTIALS_ENV = "GOOGLE_OAUTH_CLIENT_CREDENTIALS"

/** Env vars for an explicit Desktop-app client id / secret pair. */
export const GOOGLE_OAUTH_CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID"
export const GOOGLE_OAUTH_CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET"

/** User-facing copy for a build with no OAuth client configured anywhere. */
export const OAUTH_NOT_CONFIGURED = "OAuth login is not configured for this build"

/**
 * A Desktop client without its secret cannot be refreshed. The code exchange
 * may well succeed, but the `authorized_user` document minted from it carries
 * `client_secret: ""` — which this codebase's own ADC loader rejects.
 */
export const OAUTH_MISSING_CLIENT_SECRET =
  "oauthClientId was supplied without oauthClientSecret. Google issues a client secret with every Desktop app client; the credential cannot be refreshed without it."

const OAUTH_MISSING_ENV_CLIENT_SECRET =
  "GOOGLE_OAUTH_CLIENT_ID was set without GOOGLE_OAUTH_CLIENT_SECRET. Google issues a client secret with every Desktop app client; the credential cannot be refreshed without it."

const OAUTH_CLIENT_MUTUAL_EXCLUSION =
  "Supply either oauthClientId/oauthClientSecret or oauthClientFile, not both."

export type OAuthClientSource = "props" | "file" | "env-file" | "env" | "default"

export interface ResolvedOAuthClient {
  readonly clientId: string
  readonly clientSecret: string
  readonly source: OAuthClientSource
}

export interface ResolveOAuthClientInput {
  readonly clientId?: string
  readonly clientSecret?: string
  /** Path to a Google Console Desktop-app client JSON (`installed` shape). */
  readonly clientFile?: string
}

export type ParseOAuthClientResult =
  | { readonly ok: true; readonly value: { readonly clientId: string; readonly clientSecret: string } }
  | { readonly ok: false; readonly error: string }

/**
 * Expand a leading `~/` (or bare `~`) against `homeDir`. Absolute and
 * relative paths are returned trimmed and unchanged. Domain-pure: the caller
 * supplies HOME / USERPROFILE.
 */
export function expandHomePath(filePath: string, homeDir: string): string {
  const trimmed = filePath.trim()
  if (!trimmed) return ""

  if (trimmed === "~") {
    return homeDir
  }

  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    if (!homeDir) return trimmed
    const rest = trimmed.slice(2)
    const endsWithSep = homeDir.endsWith("/") || homeDir.endsWith("\\")
    const sep = homeDir.includes("\\") && !homeDir.includes("/") ? "\\" : "/"
    return `${endsWithSep ? homeDir.slice(0, -1) : homeDir}${sep}${rest}`
  }

  return trimmed
}

/**
 * Parse a Google Cloud Console OAuth client JSON download.
 *
 * Accepts the Desktop-app shape `{ "installed": { client_id, client_secret } }`.
 * Rejects the Web-app shape (`web`) — Sign-In uses a loopback redirect that
 * only Desktop clients are registered for.
 */
export function parseOAuthClientCredentialsJson(text: string): ParseOAuthClientResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: "OAuth client credentials file is not valid JSON" }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "OAuth client credentials file must be a JSON object" }
  }

  const record = parsed as Record<string, unknown>

  if ("web" in record && !("installed" in record)) {
    return {
      ok: false,
      error:
        "OAuth client credentials file is a Web client (`web`). Google Sign-In requires a Desktop app client (`installed`).",
    }
  }

  const installed = record.installed
  if (typeof installed !== "object" || installed === null || Array.isArray(installed)) {
    return {
      ok: false,
      error:
        "OAuth client credentials file is missing the `installed` object. Download a Desktop app client JSON from Google Cloud Console.",
    }
  }

  const installedRecord = installed as Record<string, unknown>
  const clientId =
    typeof installedRecord.client_id === "string" ? installedRecord.client_id.trim() : ""
  const clientSecret =
    typeof installedRecord.client_secret === "string"
      ? installedRecord.client_secret.trim()
      : ""

  if (!clientId) {
    return {
      ok: false,
      error: "OAuth client credentials file is missing `installed.client_id`",
    }
  }
  if (!clientSecret) {
    return {
      ok: false,
      error: "OAuth client credentials file is missing `installed.client_secret`",
    }
  }

  return { ok: true, value: { clientId, clientSecret } }
}

const loadClientFromFile = (rawPath: string, source: "file" | "env-file") =>
  Effect.gen(function* () {
    const env = yield* Environment
    const fs = yield* FileSystem

    const trimmed = rawPath.trim()
    if (!trimmed) {
      return yield* new GoogleOAuthError({
        message: "OAuth client credentials file path is empty",
      })
    }

    const home = (yield* env.get("HOME")) ?? (yield* env.get("USERPROFILE")) ?? ""
    if ((trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) && !home) {
      return yield* new GoogleOAuthError({
        message: "Cannot expand ~ in OAuth client credentials path: HOME is not set",
      })
    }

    const filePath = expandHomePath(trimmed, home)
    const contents = yield* fs.readFile(filePath).pipe(
      Effect.mapError(
        (err) =>
          new GoogleOAuthError({
            message: `Failed to read OAuth client credentials file: ${filePath}`,
            cause: err,
          }),
      ),
    )

    const parsed = parseOAuthClientCredentialsJson(contents)
    if (!parsed.ok) {
      return yield* new GoogleOAuthError({ message: parsed.error })
    }

    return {
      clientId: parsed.value.clientId,
      clientSecret: parsed.value.clientSecret,
      source,
    } satisfies ResolvedOAuthClient
  })

/**
 * Resolve the Desktop-app OAuth client from author props, a client JSON file,
 * operator env vars, or the build defaults.
 */
export const resolveOAuthClient = (input: ResolveOAuthClientInput = {}) =>
  Effect.gen(function* () {
    const clientId = input.clientId?.trim() || undefined
    const clientSecret = input.clientSecret?.trim() || undefined
    const clientFile = input.clientFile?.trim() || undefined

    if (clientFile && (clientId || clientSecret)) {
      return yield* new GoogleOAuthError({ message: OAUTH_CLIENT_MUTUAL_EXCLUSION })
    }

    if (clientId) {
      if (!clientSecret) {
        return yield* new GoogleOAuthError({ message: OAUTH_MISSING_CLIENT_SECRET })
      }
      return {
        clientId,
        clientSecret,
        source: "props",
      } satisfies ResolvedOAuthClient
    }

    if (clientFile) {
      return yield* loadClientFromFile(clientFile, "file")
    }

    const env = yield* Environment

    const envFile = yield* env.get(GOOGLE_OAUTH_CLIENT_CREDENTIALS_ENV)
    if (envFile?.trim()) {
      return yield* loadClientFromFile(envFile, "env-file")
    }

    const envId = (yield* env.get(GOOGLE_OAUTH_CLIENT_ID_ENV))?.trim()
    const envSecret = (yield* env.get(GOOGLE_OAUTH_CLIENT_SECRET_ENV))?.trim()
    if (envId) {
      if (!envSecret) {
        return yield* new GoogleOAuthError({ message: OAUTH_MISSING_ENV_CLIENT_SECRET })
      }
      return {
        clientId: envId,
        clientSecret: envSecret,
        source: "env",
      } satisfies ResolvedOAuthClient
    }

    if (DEFAULT_GOOGLE_OAUTH_CLIENT_ID) {
      if (!DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET) {
        return yield* new GoogleOAuthError({ message: OAUTH_MISSING_CLIENT_SECRET })
      }
      return {
        clientId: DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET,
        source: "default",
      } satisfies ResolvedOAuthClient
    }

    return yield* new GoogleOAuthError({ message: OAUTH_NOT_CONFIGURED })
  })

/**
 * Cheap capability probe: true when any resolution tier can supply a client.
 * File/env misconfiguration yields false (the start path surfaces the error).
 */
export const isOAuthClientConfigured = (input: ResolveOAuthClientInput = {}) =>
  resolveOAuthClient(input).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  )
