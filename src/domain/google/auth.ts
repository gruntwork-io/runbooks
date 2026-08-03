/**
 * Google Cloud authentication logic.
 */
import { Effect } from "effect"
import { GoogleClient } from "../../services/GoogleClient.ts"
import type {
  GoogleCredentialRef,
  GoogleIdentity,
  OAuthStartParams,
} from "../../services/GoogleClient.ts"
import { Environment } from "../../services/Environment.ts"
import type { EnvironmentShape } from "../../services/Environment.ts"
import { GoogleAuthError, GoogleOAuthError } from "../../errors/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Gruntwork's registered Google Cloud "Desktop app" OAuth client. Mirrors
 * DEFAULT_GITHUB_OAUTH_CLIENT_ID (src/domain/github/auth.ts): main owns the
 * default, an author `oauthClientId` prop may override it.
 *
 * TODO(release): populate from the Gruntwork GCP project before shipping. While
 * empty, google:oauth-start returns
 * { error: "OAuth login is not configured for this build" } and the OAuth tab
 * renders disabled with that copy.
 */
export const DEFAULT_GOOGLE_OAUTH_CLIENT_ID = ""

/**
 * The client "secret" issued alongside the Desktop client. Per RFC 8252 an
 * installed-app secret is not confidential — it ships because Google issues one
 * with every Desktop client, not because it protects anything.
 */
export const DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET = ""

/** Scopes requested by the user-login tab when the author supplies none. */
export const DEFAULT_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
] as const

/** User-facing copy for a build with no OAuth client id compiled in. */
const OAUTH_NOT_CONFIGURED = "OAuth login is not configured for this build"

/**
 * A Desktop client without its secret cannot be refreshed. The code exchange
 * may well succeed, but the `authorized_user` document minted from it carries
 * `client_secret: ""` — which this codebase's own ADC loader rejects — so every
 * later refresh (gcloud, the client libraries, the OpenTofu provider) fails.
 * Refusing here is the difference between an honest error and a credential that
 * only looks authenticated.
 */
const OAUTH_MISSING_CLIENT_SECRET =
  "oauthClientId was supplied without oauthClientSecret. Google issues a client secret with every Desktop app client; the credential cannot be refreshed without it."

/**
 * Allowlist for the `{env:{prefix}}` detectCredentials variant,
 * enforced in MAIN (the renderer-supplied prefix is untrusted input).
 * Reused verbatim from src/domain/github/auth.ts.
 */
export const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]*_$/

/**
 * Credential-bearing env vars, in precedence order: a path to a credentials
 * JSON, an inline credentials JSON, then a bare OAuth access token. A path may
 * hold EITHER a service-account key or an authorized_user document — the
 * credential's `type` field decides, never the file name.
 */
const CREDENTIAL_ENV_VARS = [
  { name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "path" },
  { name: "GOOGLE_CREDENTIALS", kind: "json" },
  { name: "GOOGLE_OAUTH_ACCESS_TOKEN", kind: "token" },
  { name: "CLOUDSDK_AUTH_ACCESS_TOKEN", kind: "token" },
] as const satisfies readonly { name: string; kind: "path" | "json" | "token" }[]

/** Project env vars, in precedence order — gcloud's own variable wins. */
const PROJECT_ENV_VARS = [
  "CLOUDSDK_CORE_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_PROJECT",
  "GCLOUD_PROJECT",
] as const

/** Compute-region env vars, in precedence order. */
const REGION_ENV_VARS = ["CLOUDSDK_COMPUTE_REGION", "GOOGLE_CLOUD_REGION"] as const

/** Compute-zone env vars. */
const ZONE_ENV_VARS = ["CLOUDSDK_COMPUTE_ZONE"] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A credential discovered in the environment. Exactly one of `credentialsPath`,
 * `credentialsJson`, or `accessToken` is set — a bare project id is not a
 * credential and never produces this value.
 */
export interface EnvGoogleCredentials {
  readonly credentialsPath?: string
  readonly credentialsJson?: string
  readonly accessToken?: string
  readonly projectId?: string
  readonly region?: string
  readonly zone?: string
  /**
   * Which env var supplied the credential — for the detection card's copy.
   * Carries the prefix when one was used (e.g. `MYAPP_GOOGLE_CREDENTIALS`).
   */
  readonly envVar?: string
}

/** What `confirmEnvCredentials` proved, plus the credential it proved it with. */
export interface ConfirmedEnvCredentials {
  /** Who the credential says you are. */
  readonly identity: GoogleIdentity
  /**
   * The detected credential, so main can materialise it to a 0600 file (inline
   * JSON) or point `GOOGLE_APPLICATION_CREDENTIALS` at it (path).
   */
  readonly credentials: EnvGoogleCredentials
}

// ---------------------------------------------------------------------------
// Credential Validation
// ---------------------------------------------------------------------------

/**
 * Validate a service-account key by minting a real access token for it — the
 * STS GetCallerIdentity analogue. `projectId` overrides the key's own
 * `project_id`.
 */
export const validateServiceAccountKey = (keyJson: string, projectId?: string) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.validateServiceAccountKey(keyJson, projectId)
  })

/**
 * Validate a bare OAuth access token via the oauth2 tokeninfo endpoint.
 */
export const validateAccessToken = (accessToken: string, projectId?: string) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.validateAccessToken(accessToken, projectId)
  })

/**
 * Validate a credentials JSON document of any supported type (authorized_user,
 * service_account, external_account, impersonated_service_account) by
 * refreshing it into an access token.
 */
export const validateAdcDocument = (adcJson: string, projectId?: string) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.validateAdcDocument(adcJson, projectId)
  })

// ---------------------------------------------------------------------------
// Credential Files
// ---------------------------------------------------------------------------

/**
 * Read and classify a credentials JSON path. Metadata only — the result never
 * carries private_key, client_secret, or refresh_token.
 */
export const readCredentialFile = (filePath: string) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.readCredentialFile(filePath)
  })

/**
 * Read a credentials JSON path in full, including secret material. For
 * validation and materialisation inside main only — the contents never cross
 * IPC.
 */
export const readCredentialFileContents = (filePath: string) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.readCredentialFileContents(filePath)
  })

// ---------------------------------------------------------------------------
// gcloud Configurations
// ---------------------------------------------------------------------------

/**
 * List the gcloud configurations on disk, plus the well-known Application
 * Default Credentials metadata. Never shells out to the gcloud binary.
 */
export const listGcloudConfigurations = () =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.listGcloudConfigurations()
  })

/**
 * Metadata for the well-known application_default_credentials.json, or
 * undefined when the file does not exist.
 */
export const readApplicationDefaultCredentials = () =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.readApplicationDefaultCredentials()
  })

// ---------------------------------------------------------------------------
// OAuth (loopback redirect + PKCE)
// ---------------------------------------------------------------------------

/**
 * Start a loopback-redirect OAuth flow. Returns the authorization URL to open
 * in the user's browser and an opaque handle for poll/cancel.
 *
 * A build with no OAuth client id — or an author-supplied client id with no
 * secret — fails here rather than opening a browser at a URL Google will reject
 * (or minting a credential that cannot be refreshed); the caller surfaces the
 * message verbatim and the OAuth tab renders disabled.
 */
export const startOAuthFlow = (params: OAuthStartParams) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient

    if (!params.clientId) {
      return yield* new GoogleOAuthError({ message: OAUTH_NOT_CONFIGURED })
    }

    if (!params.clientSecret) {
      return yield* new GoogleOAuthError({ message: OAUTH_MISSING_CLIENT_SECRET })
    }

    return yield* googleClient.startOAuthFlow(params)
  })

/**
 * Poll a loopback flow. Returns { status: "pending" } until the browser
 * callback lands on the listener.
 */
export const pollOAuthFlow = (flowId: string) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.pollOAuthFlow(flowId)
  })

/**
 * Cancel a loopback flow: closes the listening socket and drops the flow
 * record. Safe to call for a flow that already finished.
 */
export const cancelOAuthFlow = (flowId: string) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.cancelOAuthFlow(flowId)
  })

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * List the projects visible to a credential, optionally filtered by a search
 * query. The SSO account-list analogue.
 */
export const listProjects = (
  creds: GoogleCredentialRef,
  query?: string,
  pageSize?: number,
) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.listProjects(creds, query, pageSize)
  })

/**
 * Check whether a project exists AND is readable with the given credential.
 */
export const checkProject = (projectId: string, creds: GoogleCredentialRef) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient
    return yield* googleClient.checkProject(projectId, creds)
  })

// ---------------------------------------------------------------------------
// Environment Credential Detection
// ---------------------------------------------------------------------------

/** First non-empty value among `${prefix}${name}`, in the listed order. */
const firstEnvValue = (
  env: EnvironmentShape,
  prefix: string,
  names: readonly string[],
) =>
  Effect.gen(function* () {
    for (const name of names) {
      const value = yield* env.get(`${prefix}${name}`)
      if (value) return value
    }
    return undefined
  })

/**
 * Detect Google Cloud credentials from environment variables.
 *
 * Credential precedence: GOOGLE_APPLICATION_CREDENTIALS (path) ->
 * GOOGLE_CREDENTIALS (inline JSON) -> GOOGLE_OAUTH_ACCESS_TOKEN ->
 * CLOUDSDK_AUTH_ACCESS_TOKEN. Project, region, and zone are enrichment only:
 * returns undefined unless a CREDENTIAL was found, because a bare project id
 * authenticates nothing.
 *
 * With a `prefix` (the `{env:{prefix}}` variant) every name is looked up with
 * the prefix prepended. The prefix MUST already be allowlist-validated
 * (ENV_PREFIX_PATTERN) by the caller in main; an invalid prefix yields
 * undefined here as defense in depth, and never falls back to the unprefixed
 * names — that would authenticate against a credential the author did not ask
 * for.
 */
export const detectEnvCredentials = (prefix?: string) =>
  Effect.gen(function* () {
    const env = yield* Environment

    if (prefix !== undefined && prefix !== "" && !ENV_PREFIX_PATTERN.test(prefix)) {
      return undefined
    }
    const p = prefix ?? ""

    let credential:
      | { readonly kind: "path" | "json" | "token"; readonly envVar: string; readonly value: string }
      | undefined

    for (const { name, kind } of CREDENTIAL_ENV_VARS) {
      const envVar = `${p}${name}`
      const value = yield* env.get(envVar)
      if (value) {
        credential = { kind, envVar, value }
        break
      }
    }

    if (!credential) {
      return undefined
    }

    const projectId = yield* firstEnvValue(env, p, PROJECT_ENV_VARS)
    const region = yield* firstEnvValue(env, p, REGION_ENV_VARS)
    const zone = yield* firstEnvValue(env, p, ZONE_ENV_VARS)

    const result: EnvGoogleCredentials = {
      ...(credential.kind === "path" ? { credentialsPath: credential.value } : {}),
      ...(credential.kind === "json" ? { credentialsJson: credential.value } : {}),
      ...(credential.kind === "token" ? { accessToken: credential.value } : {}),
      envVar: credential.envVar,
      ...(projectId ? { projectId } : {}),
      ...(region ? { region } : {}),
      ...(zone ? { zone } : {}),
    }

    return result
  })

/**
 * Validate whichever shape the environment supplied. A credentials path is read
 * first and then validated as a document, so a service-account key and an
 * authorized_user file both work through the same branch.
 */
const validateDetectedCredential = (creds: EnvGoogleCredentials) =>
  Effect.gen(function* () {
    const googleClient = yield* GoogleClient

    if (creds.credentialsPath) {
      const contents = yield* googleClient
        .readCredentialFileContents(creds.credentialsPath)
        .pipe(
          Effect.mapError(
            (err) => new GoogleAuthError({ message: err.message, cause: err }),
          ),
        )
      return yield* googleClient.validateAdcDocument(contents, creds.projectId)
    }

    if (creds.credentialsJson) {
      return yield* googleClient.validateAdcDocument(creds.credentialsJson, creds.projectId)
    }

    if (creds.accessToken) {
      return yield* googleClient.validateAccessToken(creds.accessToken, creds.projectId)
    }

    return yield* new GoogleAuthError({
      message: "No Google Cloud credentials found in environment variables",
    })
  })

/**
 * Validate credentials detected from environment variables and return them
 * alongside the proven identity. Fails with GoogleAuthError when nothing was
 * detected, or when the detected credential does not authenticate.
 *
 * Detection is read-only; confirmation is what makes an ambient credential
 * *this block's* credential, so the two are deliberately separate calls.
 */
export const confirmEnvCredentials = (prefix?: string) =>
  Effect.gen(function* () {
    const envCreds = yield* detectEnvCredentials(prefix)

    if (!envCreds) {
      return yield* new GoogleAuthError({
        message: "No Google Cloud credentials found in environment variables",
      })
    }

    const identity = yield* validateDetectedCredential(envCreds)

    return { identity, credentials: envCreds } satisfies ConfirmedEnvCredentials
  })
