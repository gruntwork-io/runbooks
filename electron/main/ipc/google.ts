/**
 * IPC handlers for Google Cloud authentication.
 *
 * Bridges Electron ipcMain to the Google auth domain module: service-account
 * key validation, the loopback OAuth flow, gcloud-configuration auth, ambient
 * credential detection, and project selection.
 *
 * Custody (plan §6): the renderer may SEND a secret the user pasted, but no
 * `google:*` result ever returns credential material. MAIN materialises the
 * credentials file, writes the session env, and hands back metadata only —
 * the discipline github.ts follows, not the raw-key round trip aws.ts performs.
 * Two rules follow from that and are load bearing here:
 *   1. every secret is `registerSecret`ed BEFORE anything that could throw with
 *      the material in its message, and every outbound `error` string goes
 *      through `redactSecrets` (a JSON parse failure or a JWT signing error can
 *      otherwise carry a private key);
 *   2. a session-env write that fails must never void a credential that just
 *      validated — it degrades to `sessionEnvWarning` copy on the success card.
 *
 * All errors surfaced from here are RUNTIME errors per AGENTS.md: they render
 * inline in the block, never via reportError().
 */
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import {
  validateServiceAccountKey,
  validateAccessToken,
  validateAdcDocument,
  readCredentialFile,
  readCredentialFileContents,
  listGcloudConfigurations,
  readApplicationDefaultCredentials,
  startOAuthFlow,
  pollOAuthFlow,
  cancelOAuthFlow,
  listProjects,
  checkProject,
  detectEnvCredentials,
  DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
  DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET,
  DEFAULT_GOOGLE_SCOPES,
  ENV_PREFIX_PATTERN,
} from "../../../src/domain/google/auth.ts"
import {
  evaluateRequiredGoogleScopes,
  insufficientScopesErrorMessage,
} from "../../../src/domain/google/scopes.ts"
import type {
  AdcInfo,
  GcloudConfiguration,
  GoogleCredentialRef,
  GoogleIdentity,
  GoogleProject,
} from "../../../src/services/GoogleClient.ts"
import type {
  AdcInfoIpc,
  GcloudConfigurationIpc,
  GoogleAccountInfo,
  GoogleCredentialTypeIpc,
  GoogleProjectIpc,
} from "../../shared/channels.ts"
import {
  activeCredentialFor,
  identityKeyFor,
  materializeForIdentity,
  setActiveCredential,
} from "./google-credential-registry.ts"
import { redactSecrets, registerSecret } from "../../../src/domain/vcs/redact.ts"

/** Which ambient location a detection request should read. */
type DetectionSource = "env" | "adc" | "gcloud"

// ---------------------------------------------------------------------------
// Main-process credential state
//
// The per-block credential registry lives in ./google-credential-registry.ts:
// the same state, split out so its multi-block rules — a block never borrows a
// neighbour's credential, and a block's materialised file is released only by
// that block re-authenticating — can be exercised without an Electron ipcMain.
// ---------------------------------------------------------------------------

/**
 * Credential established by a completed OAuth flow, keyed by its flowId, so the
 * project picker can list projects for the flow it just finished. Only one
 * loopback flow is meaningful at a time, so the map is reset on every
 * completion rather than grown.
 */
const flowCredentials = new Map<string, GoogleCredentialRef>()

/**
 * Display names learned from the last project listing, so `google:set-project`
 * can name the project without a second Resource Manager round trip.
 */
const projectDisplayNames = new Map<string, string>()

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

/**
 * Register every secret-bearing field of a credentials document for redaction.
 * Called before any parse or validate that could throw with the material in its
 * message — the raw document is registered first so even a truncated/malformed
 * document is covered.
 */
function registerCredentialSecrets(json: string): void {
  registerSecret(json)
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    for (const field of ["private_key", "client_secret", "refresh_token", "access_token"]) {
      const value = parsed[field]
      if (typeof value === "string") registerSecret(value)
    }
  } catch {
    // Not parseable JSON: the raw string above is what redaction needs anyway.
  }
}

/** Every error string leaving this module goes through here. */
const toErrorMessage = (err: unknown): string =>
  redactSecrets(err instanceof Error ? err.message : String(err))

/** The raw `type` field of a credentials document, when it has a readable one. */
function readRawCredentialType(json: string): string | undefined {
  try {
    const parsed = JSON.parse(json) as { type?: unknown }
    return typeof parsed.type === "string" ? parsed.type : undefined
  } catch {
    return undefined
  }
}

/**
 * Narrow a credentials document's `type` onto the IPC union.
 * Mirrors `credentialTypeFromDocumentType` in gcloud-config: workforce/workload
 * pools write `external_account_authorized_user`, which authenticates like an
 * external account.
 */
function readCredentialTypeSafe(json: string): GoogleCredentialTypeIpc | undefined {
  const type = readRawCredentialType(json)
  switch (type) {
    case "service_account":
    case "authorized_user":
    case "external_account":
    case "impersonated_service_account":
    case "access_token":
    case "gce_metadata":
      return type
    case "external_account_authorized_user":
      return "external_account"
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// IPC DTO mappers — metadata only, by construction
// ---------------------------------------------------------------------------

const toAccountInfo = (identity: GoogleIdentity): GoogleAccountInfo => ({
  principal: identity.email,
  accountType: identity.accountType,
  ...(identity.scopes ? { scopes: [...identity.scopes] } : {}),
})

const toProjectIpc = (project: GoogleProject): GoogleProjectIpc => ({
  projectId: project.projectId,
  displayName: project.displayName,
  ...(project.projectNumber ? { projectNumber: project.projectNumber } : {}),
  ...(project.state ? { state: project.state } : {}),
})

const toConfigurationIpc = (config: GcloudConfiguration): GcloudConfigurationIpc => ({
  name: config.name,
  isActive: config.isActive,
  ...(config.account ? { account: config.account } : {}),
  ...(config.project ? { project: config.project } : {}),
  ...(config.region ? { region: config.region } : {}),
  ...(config.zone ? { zone: config.zone } : {}),
  authType: config.authType,
})

const toAdcInfoIpc = (adc: AdcInfo): AdcInfoIpc => ({
  path: adc.path,
  type: adc.type,
  ...(adc.clientEmail ? { clientEmail: adc.clientEmail } : {}),
  ...(adc.quotaProjectId ? { quotaProjectId: adc.quotaProjectId } : {}),
})

// ---------------------------------------------------------------------------
// Session environment
// ---------------------------------------------------------------------------

interface SessionEnvInput {
  readonly credentialsPath?: string
  /** §8.4 only: a bearer the environment ALREADY contained. We never mint one. */
  readonly accessToken?: string
  readonly projectId?: string
  readonly principal?: string
  readonly region?: string
  readonly zone?: string
  readonly configuration?: string
}

/**
 * The session env every successful Google authentication writes (§7.1).
 *
 * Nothing is ever written empty: an unset-but-present
 * GOOGLE_APPLICATION_CREDENTIALS pointing at a bogus path is a hard error in
 * every Google client library and would break every subsequent `<Command>`.
 * Inline key material (`GOOGLE_CREDENTIALS` and friends) is never written at
 * all — the credential reaches the child process as a 0600 file path.
 */
function buildGoogleSessionEnv(input: SessionEnvInput): Record<string, string> {
  const env: Record<string, string> = {}

  if (input.credentialsPath) {
    env.GOOGLE_APPLICATION_CREDENTIALS = input.credentialsPath
  } else if (input.accessToken) {
    // The single documented exception to D6: an access token the user's
    // environment already supplied, re-exported under its canonical names.
    env.GOOGLE_OAUTH_ACCESS_TOKEN = input.accessToken
    env.CLOUDSDK_AUTH_ACCESS_TOKEN = input.accessToken
  }

  if (input.projectId) {
    env.GOOGLE_CLOUD_PROJECT = input.projectId
    env.CLOUDSDK_CORE_PROJECT = input.projectId
    // The Terraform/OpenTofu `google` provider's first-choice variable.
    env.GOOGLE_PROJECT = input.projectId
  }
  if (input.principal) env.CLOUDSDK_CORE_ACCOUNT = input.principal
  if (input.region) {
    env.GOOGLE_CLOUD_REGION = input.region
    env.CLOUDSDK_COMPUTE_REGION = input.region
    env.GOOGLE_REGION = input.region
  }
  if (input.zone) {
    env.CLOUDSDK_COMPUTE_ZONE = input.zone
    env.GOOGLE_ZONE = input.zone
  }
  // The AWS_PROFILE analogue — gcloud tab only.
  if (input.configuration) env.CLOUDSDK_ACTIVE_CONFIG_NAME = input.configuration

  return env
}

/**
 * Append to the session env, reproducing appendSessionEnvAndRecord's failure
 * semantics without its GitProvider typing or its vcs:session-changed push: a
 * failed write returns the success-card warning copy instead of failing the
 * authentication. Undefined on success.
 */
async function appendGoogleSessionEnv(env: Record<string, string>): Promise<string | undefined> {
  if (Object.keys(env).length === 0) return undefined
  try {
    await runtime.runPromise(sessionManager.appendToEnv(env))
    return undefined
  } catch (err) {
    return `Authenticated, but the credential could not be saved to the session (${toErrorMessage(err)}). Blocks that consume it may not see it.`
  }
}

// ---------------------------------------------------------------------------
// Validation + credential establishment
// ---------------------------------------------------------------------------

/**
 * Validate a credentials document. `authorized_user`, `external_account` and
 * `impersonated_service_account` take the ADC path; a service-account key — and
 * anything whose `type` cannot be read, which is overwhelmingly a mis-pasted
 * key — takes the service-account path, whose error copy names the problem.
 */
async function validateCredentialDocument(
  json: string,
  projectIdOverride?: string,
): Promise<GoogleIdentity> {
  registerCredentialSecrets(json)
  // Route on the raw document type — `external_account_authorized_user` is a
  // real Google ADC shape that maps to `external_account` for IPC metadata, but
  // must still take the ADC validation path here.
  const type = readRawCredentialType(json)
  const isAdcDocument =
    type === "authorized_user" ||
    type === "external_account" ||
    // A workforce-pool `gcloud auth application-default login` writes exactly
    // this type. Omitting it routed that document to validateServiceAccountKey,
    // which rejected the user's perfectly good ADC as "Not a service account key".
    type === "external_account_authorized_user" ||
    type === "impersonated_service_account"
  return isAdcDocument
    ? runtime.runPromise(validateAdcDocument(json, projectIdOverride))
    : runtime.runPromise(validateServiceAccountKey(json, projectIdOverride))
}

interface AuthSuccessInput {
  /** The GoogleAuth block this credential belongs to. Never a global. */
  readonly blockId?: string
  readonly identity: GoogleIdentity
  /** Credential document to materialise, when it is not already a file on disk. */
  readonly documentJson?: string
  /** An existing on-disk credential file — reused as-is, never copied. */
  readonly existingPath?: string
  /** §8.4 only. */
  readonly accessToken?: string
  readonly projectId?: string
  readonly region?: string
  readonly zone?: string
  readonly configuration?: string
}

interface AuthSuccess {
  readonly ref: GoogleCredentialRef
  readonly credentialsPath?: string
  readonly projectId?: string
  readonly sessionEnvWarning?: string
}

/**
 * The shared success path for every tab: materialise (unless the credential is
 * already a file we can point at), write the session env, and remember the
 * credential so the project channels can use it. Returns metadata only.
 */
async function registerAuthenticatedCredential(input: AuthSuccessInput): Promise<AuthSuccess> {
  const projectId = input.projectId ?? input.identity.projectId
  const credentialsPath =
    input.existingPath ??
    (input.documentJson
      ? materializeForIdentity(
          identityKeyFor(input.blockId, input.identity, projectId),
          input.documentJson,
        )
      : undefined)

  const ref: GoogleCredentialRef = credentialsPath
    ? { kind: "file", path: credentialsPath }
    : { kind: "access_token", accessToken: input.accessToken ?? "" }

  const sessionEnvWarning = await appendGoogleSessionEnv(
    buildGoogleSessionEnv({
      credentialsPath,
      accessToken: input.accessToken,
      projectId,
      principal: input.identity.email,
      region: input.region,
      zone: input.zone,
      configuration: input.configuration,
    }),
  )

  setActiveCredential(input.blockId, {
    ref,
    credentialsPath,
    principal: input.identity.email,
    credentialType: input.identity.credentialType,
    projectId,
    region: input.region,
    zone: input.zone,
    configuration: input.configuration,
  })

  return {
    ref,
    ...(credentialsPath ? { credentialsPath } : {}),
    ...(projectId ? { projectId } : {}),
    ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
  }
}

/**
 * Best-effort project listing. A credential that cannot search projects — a
 * service account without org-level resourcemanager permissions is the common
 * case — must never fail an authentication that otherwise succeeded.
 */
async function listProjectsSafe(
  ref: GoogleCredentialRef,
  query?: string,
  pageSize?: number,
): Promise<GoogleProjectIpc[]> {
  try {
    const projects = await runtime.runPromise(listProjects(ref, query, pageSize))
    const mapped = projects.map(toProjectIpc)
    for (const project of mapped) projectDisplayNames.set(project.projectId, project.displayName)
    return mapped
  } catch {
    return []
  }
}

/**
 * The credential subsequent project calls run against: the flow that just
 * completed, then the CALLING BLOCK's own credential, then whatever the session
 * env points at (an earlier GoogleAuth block in the same session). Never passed
 * in by the renderer — it does not have it.
 */
async function resolveCredentialRef(
  blockId?: string,
  flowId?: string,
): Promise<GoogleCredentialRef | undefined> {
  if (flowId) {
    const flowRef = flowCredentials.get(flowId)
    if (flowRef) return flowRef
  }
  const active = activeCredentialFor(blockId)
  if (active) return active.ref
  try {
    const session = await runtime.runPromise(sessionManager.getSession())
    const path = session.env.get("GOOGLE_APPLICATION_CREDENTIALS")
    if (path) return { kind: "file", path }
    const token = session.env.get("GOOGLE_OAUTH_ACCESS_TOKEN")
    if (token) return { kind: "access_token", accessToken: token }
  } catch {
    // No active session yet — nothing ambient to fall back on.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Ambient credential detection (the 'env' / 'adc' / 'gcloud' sources)
// ---------------------------------------------------------------------------

/**
 * A credential located by detection, before it has been validated. Carries
 * secret material (`documentJson` / `accessToken`) and therefore never leaves
 * this module — only the metadata fields are copied into an IPC result.
 */
interface ResolvedCredential {
  readonly source: DetectionSource
  readonly documentJson?: string
  /** On-disk credential file. A path is not a secret (D12). */
  readonly path?: string
  readonly accessToken?: string
  readonly credentialType?: GoogleCredentialTypeIpc
  readonly projectId?: string
  readonly region?: string
  readonly zone?: string
  readonly envVar?: string
  readonly configuration?: string
  readonly quotaProjectId?: string
}

/** Metadata for a credential file, or undefined when it cannot be read. */
async function readCredentialFileSafe(filePath: string): Promise<AdcInfo | undefined> {
  try {
    return await runtime.runPromise(readCredentialFile(filePath))
  } catch {
    // A GOOGLE_APPLICATION_CREDENTIALS pointing at a missing or unreadable file
    // is "found but invalid", not "not found" — let validation say so.
    return undefined
  }
}

async function resolveEnvSource(
  prefix: string | undefined,
  defaultProject: string | undefined,
): Promise<ResolvedCredential | undefined> {
  const env = await runtime.runPromise(detectEnvCredentials(prefix))
  if (!env) return undefined

  const base = {
    source: "env" as const,
    projectId: env.projectId ?? defaultProject,
    ...(env.region ? { region: env.region } : {}),
    ...(env.zone ? { zone: env.zone } : {}),
    ...(env.envVar ? { envVar: env.envVar } : {}),
  }

  if (env.credentialsPath) {
    const info = await readCredentialFileSafe(env.credentialsPath)
    return {
      ...base,
      path: env.credentialsPath,
      ...(info?.type ? { credentialType: info.type } : {}),
      ...(info?.quotaProjectId ? { quotaProjectId: info.quotaProjectId } : {}),
    }
  }
  if (env.credentialsJson) {
    registerCredentialSecrets(env.credentialsJson)
    const type = readCredentialTypeSafe(env.credentialsJson)
    return { ...base, documentJson: env.credentialsJson, ...(type ? { credentialType: type } : {}) }
  }
  if (env.accessToken) {
    registerSecret(env.accessToken)
    return { ...base, accessToken: env.accessToken, credentialType: "access_token" }
  }
  return undefined
}

async function resolveAdcSource(
  defaultProject: string | undefined,
): Promise<ResolvedCredential | undefined> {
  const adc = await runtime.runPromise(readApplicationDefaultCredentials())
  if (!adc) return undefined
  const projectId = defaultProject ?? adc.quotaProjectId
  return {
    source: "adc",
    path: adc.path,
    credentialType: adc.type,
    ...(projectId ? { projectId } : {}),
    ...(adc.quotaProjectId ? { quotaProjectId: adc.quotaProjectId } : {}),
  }
}

interface GcloudResolution {
  readonly configuration?: GcloudConfiguration
  readonly adc?: AdcInfo
  readonly configRoot: string
}

/** The named gcloud configuration, or the active one when no name is given. */
async function resolveGcloudConfiguration(name?: string): Promise<GcloudResolution> {
  const listing = await runtime.runPromise(listGcloudConfigurations())
  const configuration = name
    ? listing.configurations.find((c) => c.name === name)
    : (listing.configurations.find((c) => c.isActive) ??
      listing.configurations.find((c) => c.name === listing.activeConfiguration))
  return {
    ...(configuration ? { configuration } : {}),
    ...(listing.adc ? { adc: listing.adc } : {}),
    configRoot: listing.configRoot,
  }
}

async function resolveGcloudSource(
  configurationName: string | undefined,
  defaultProject: string | undefined,
): Promise<ResolvedCredential | undefined> {
  const resolved = await resolveGcloudConfiguration(configurationName)
  // A gcloud configuration is not self-sufficient the way an AWS profile is:
  // without Application Default Credentials there is nothing to authenticate
  // with, however complete the configuration looks.
  if (!resolved.configuration || !resolved.adc) return undefined
  const { configuration, adc } = resolved
  const projectId = defaultProject ?? configuration.project
  return {
    source: "gcloud",
    path: adc.path,
    credentialType: adc.type,
    ...(projectId ? { projectId } : {}),
    ...(configuration.region ? { region: configuration.region } : {}),
    ...(configuration.zone ? { zone: configuration.zone } : {}),
    ...(adc.quotaProjectId ? { quotaProjectId: adc.quotaProjectId } : {}),
    configuration: configuration.name,
  }
}

function resolveDetectionSource(
  source: DetectionSource,
  prefix: string | undefined,
  configuration: string | undefined,
  defaultProject: string | undefined,
): Promise<ResolvedCredential | undefined> {
  switch (source) {
    case "adc":
      return resolveAdcSource(defaultProject)
    case "gcloud":
      return resolveGcloudSource(configuration, defaultProject)
    case "env":
      return resolveEnvSource(prefix, defaultProject)
  }
}

/** Validate whatever detection found, reading the file when it is a path. */
async function validateResolvedCredential(resolved: ResolvedCredential): Promise<GoogleIdentity> {
  if (resolved.accessToken) {
    return runtime.runPromise(validateAccessToken(resolved.accessToken, resolved.projectId))
  }
  const documentJson =
    resolved.documentJson ??
    (resolved.path ? await runtime.runPromise(readCredentialFileContents(resolved.path)) : undefined)
  if (!documentJson) {
    throw new Error("No Google Cloud credentials found")
  }
  return validateCredentialDocument(documentJson, resolved.projectId)
}

/**
 * The prefix is untrusted renderer input: allowlist-validate it in MAIN before
 * it is ever used to build an env var name (github.ts:170-177 precedent).
 */
function invalidPrefixError(prefix: string | undefined): string | undefined {
  if (prefix !== undefined && !ENV_PREFIX_PATTERN.test(prefix)) {
    return `Invalid env prefix "${prefix}": must match ${ENV_PREFIX_PATTERN}`
  }
  return undefined
}


/** Refuse user ADC that lacks the author's explicitly required scopes. */
function scopeCheckFailure(
  identity: GoogleIdentity,
  required: string[] | undefined,
):
  | {
      insufficientScopes: true
      missingScopes: string[]
      grantedScopes: string[]
      error: string
    }
  | undefined {
  if (!required?.length) return undefined
  const evaluation = evaluateRequiredGoogleScopes({
    required,
    granted: identity.scopes,
    accountType: identity.accountType,
    credentialType: identity.credentialType,
  })
  if (evaluation.ok) return undefined
  return {
    insufficientScopes: true,
    missingScopes: [...evaluation.missing],
    grantedScopes: [...evaluation.granted],
    error: insufficientScopesErrorMessage(evaluation.missing, required),
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerGoogleHandlers(): void {
  // -------------------------------------------------------------------------
  // Service-account tab, and the read-only probe used by the {block:id} source
  // -------------------------------------------------------------------------
  ipcMain.handle(
    "google:validate-credentials",
    async (
      _event,
      params: {
        blockId?: string
        keyJson?: string
        keyPath?: string
        accessToken?: string
        projectId?: string
        region?: string
        zone?: string
        registerSession?: boolean
      },
    ) => {
      try {
        let identity: GoogleIdentity
        let documentJson: string | undefined
        let existingPath: string | undefined

        if (params.keyJson) {
          documentJson = params.keyJson
          identity = await validateCredentialDocument(documentJson, params.projectId)
        } else if (params.keyPath) {
          // An existing file is pointed at, never copied: the fewer places key
          // material lives, the better.
          existingPath = params.keyPath
          documentJson = await runtime.runPromise(readCredentialFileContents(params.keyPath))
          identity = await validateCredentialDocument(documentJson, params.projectId)
        } else if (params.accessToken) {
          registerSecret(params.accessToken)
          identity = await runtime.runPromise(
            validateAccessToken(params.accessToken, params.projectId),
          )
        } else {
          return { valid: false, error: "No Google Cloud credentials provided" }
        }

        const base = {
          valid: true as const,
          account: toAccountInfo(identity),
          ...(identity.projectId ? { projectId: identity.projectId } : {}),
          ...(identity.projectName ? { projectName: identity.projectName } : {}),
          credentialType: identity.credentialType,
        }

        // Detection is read-only; confirmation is what makes a credential this
        // block's credential. registerSession is that confirmation.
        if (!params.registerSession) return base

        const success = await registerAuthenticatedCredential({
          ...(params.blockId ? { blockId: params.blockId } : {}),
          identity,
          // registerAuthenticatedCredential prefers existingPath: a credential
          // the caller pointed at on disk is used where it lives, never copied.
          ...(documentJson ? { documentJson } : {}),
          ...(existingPath ? { existingPath } : {}),
          ...(params.accessToken ? { accessToken: params.accessToken } : {}),
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.region ? { region: params.region } : {}),
          ...(params.zone ? { zone: params.zone } : {}),
        })

        const projects = await listProjectsSafe(success.ref)

        return {
          ...base,
          ...(success.projectId ? { projectId: success.projectId } : {}),
          ...(success.credentialsPath ? { credentialsPath: success.credentialsPath } : {}),
          // Always sent when there is anything to send: a SINGLE visible project
          // is what the renderer auto-selects, so withholding it strands a
          // credential whose own document carries no project_id.
          ...(projects.length > 0 ? { projects } : {}),
          ...(success.sessionEnvWarning ? { sessionEnvWarning: success.sessionEnvWarning } : {}),
        }
      } catch (err) {
        return { valid: false, error: toErrorMessage(err) }
      }
    },
  )

  // -------------------------------------------------------------------------
  // OAuth tab — loopback redirect + PKCE (D3). The listener lives in the layer;
  // only the opaque flowId ever crosses IPC.
  // -------------------------------------------------------------------------
  // Cheap capability probe so the block can render the Google Sign-In tab
  // disabled on FIRST paint, instead of only after a click that was always
  // going to fail. The client id itself never crosses IPC.
  ipcMain.handle("google:oauth-available", () => ({
    available: DEFAULT_GOOGLE_OAUTH_CLIENT_ID.length > 0,
  }))

  ipcMain.handle(
    "google:oauth-start",
    async (
      _event,
      params: { clientId?: string; clientSecret?: string; scopes?: string[]; loginHint?: string },
    ) => {
      // MAIN owns the defaults; an author-supplied client id is never paired
      // with the built-in secret.
      const clientId = params.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID
      const clientSecret = params.clientId ? params.clientSecret : DEFAULT_GOOGLE_OAUTH_CLIENT_SECRET

      if (!clientId) {
        return { error: "OAuth login is not configured for this build" }
      }
      // A Desktop client without its secret cannot be refreshed: the exchange
      // may succeed, but the authorized_user document written from it would
      // carry client_secret:"" and every later refresh — gcloud, the client
      // libraries, the OpenTofu provider — would fail. Refuse up front rather
      // than publish a credential that only looks authenticated.
      if (!clientSecret) {
        return {
          error:
            "oauthClientId was supplied without oauthClientSecret. Google issues a client secret with every Desktop app client; the credential cannot be refreshed without it.",
        }
      }
      registerSecret(clientSecret)

      const scopes = params.scopes?.length ? params.scopes : [...DEFAULT_GOOGLE_SCOPES]

      try {
        const flow = await runtime.runPromise(
          startOAuthFlow({
            clientId,
            clientSecret,
            scopes,
            ...(params.loginHint ? { loginHint: params.loginHint } : {}),
          }),
        )
        return {
          flowId: flow.flowId,
          authUrl: flow.authUrl,
          redirectUri: flow.redirectUri,
          expiresInSeconds: flow.expiresInSeconds,
        }
      } catch (err) {
        return { error: toErrorMessage(err) }
      }
    },
  )

  ipcMain.handle("google:oauth-poll", async (_event, params: { flowId: string; blockId?: string }) => {
    try {
      const result = await runtime.runPromise(pollOAuthFlow(params.flowId))

      if (result.status === "pending") return { status: "pending" as const }
      if (result.status !== "complete") {
        return {
          status: result.status,
          ...(result.error ? { error: redactSecrets(result.error) } : {}),
        }
      }
      if (!result.adcJson) {
        return { status: "failed" as const, error: "Sign-in completed without returning credentials" }
      }

      registerCredentialSecrets(result.adcJson)
      registerSecret(result.accessToken)

      // The freshly minted token is the cheap way to read identity; the
      // long-lived refresh token in the ADC document is what gets materialised
      // (D6 — a one-hour bearer would go stale mid-runbook).
      const identity = result.accessToken
        ? await runtime.runPromise(validateAccessToken(result.accessToken))
        : await runtime.runPromise(validateAdcDocument(result.adcJson))

      const success = await registerAuthenticatedCredential({
        ...(params.blockId ? { blockId: params.blockId } : {}),
        identity,
        documentJson: result.adcJson,
      })

      flowCredentials.clear()
      flowCredentials.set(params.flowId, success.ref)

      // The OAuth tab is the one tab that can have no implicit project, so the
      // picker gets the full list — including a single project, which the hook
      // auto-selects.
      const projects = await listProjectsSafe(success.ref)
      const scopes = result.scopes ?? identity.scopes

      return {
        status: "complete" as const,
        account: toAccountInfo(identity),
        ...(success.projectId ? { projectId: success.projectId } : {}),
        ...(success.credentialsPath ? { credentialsPath: success.credentialsPath } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        ...(scopes ? { scopes: [...scopes] } : {}),
        ...(success.sessionEnvWarning ? { sessionEnvWarning: success.sessionEnvWarning } : {}),
      }
    } catch (err) {
      return { status: "failed" as const, error: toErrorMessage(err) }
    }
  })

  // A loopback listener is a real OS resource: cancelling must reach main, and
  // must succeed even if the flow is already gone.
  ipcMain.handle("google:oauth-cancel", async (_event, params: { flowId: string }) => {
    try {
      await runtime.runPromise(cancelOAuthFlow(params.flowId))
    } catch {
      // Already closed, expired, or never existed — nothing left to release.
    }
    flowCredentials.delete(params.flowId)
    return { ok: true as const }
  })

  // -------------------------------------------------------------------------
  // gcloud tab
  // -------------------------------------------------------------------------
  ipcMain.handle("google:gcloud-configurations", async () => {
    try {
      const listing = await runtime.runPromise(listGcloudConfigurations())
      return {
        configurations: listing.configurations.map(toConfigurationIpc),
        ...(listing.activeConfiguration ? { activeConfiguration: listing.activeConfiguration } : {}),
        configRoot: listing.configRoot,
        ...(listing.adc ? { adc: toAdcInfoIpc(listing.adc) } : {}),
      }
    } catch (err) {
      return { configurations: [], error: toErrorMessage(err) }
    }
  })

  ipcMain.handle(
    "google:gcloud-auth",
    async (
      _event,
      params: {
        blockId?: string
        configuration: string
        projectId?: string
        region?: string
        zone?: string
        scopes?: string[]
      },
    ) => {
      try {
        const resolved = await resolveGcloudConfiguration(params.configuration)
        if (!resolved.configuration) {
          return {
            valid: false,
            error: `gcloud configuration "${params.configuration}" was not found in ${resolved.configRoot}`,
          }
        }
        if (!resolved.adc) {
          return {
            valid: false,
            error: `Configuration "${params.configuration}" has no Application Default Credentials — run \`gcloud auth application-default login\`.`,
          }
        }

        const { configuration, adc } = resolved
        const projectId = params.projectId ?? configuration.project
        const region = params.region ?? configuration.region
        const zone = params.zone ?? configuration.zone
        const documentJson = await runtime.runPromise(readCredentialFileContents(adc.path))
        const identity = await validateCredentialDocument(documentJson, projectId)

        const scopeFailure = scopeCheckFailure(identity, params.scopes)
        if (scopeFailure) {
          return {
            valid: false,
            account: toAccountInfo(identity),
            ...scopeFailure,
          }
        }

        // Nothing is materialised for this tab: GOOGLE_APPLICATION_CREDENTIALS
        // points at the user's own application_default_credentials.json.
        const success = await registerAuthenticatedCredential({
          ...(params.blockId ? { blockId: params.blockId } : {}),
          identity,
          existingPath: adc.path,
          ...(projectId ? { projectId } : {}),
          ...(region ? { region } : {}),
          ...(zone ? { zone } : {}),
          configuration: configuration.name,
        })

        const projects = await listProjectsSafe(success.ref)

        return {
          valid: true,
          account: toAccountInfo(identity),
          ...(success.projectId ? { projectId: success.projectId } : {}),
          ...(success.credentialsPath ? { credentialsPath: success.credentialsPath } : {}),
          // Sent whenever there is anything to send. A configuration with no
          // `core/project` set has nothing to fall back on, so even a SINGLE
          // visible project matters — the renderer auto-selects it rather than
          // reporting success with a blank project.
          ...(projects.length > 0 ? { projects } : {}),
          ...(success.sessionEnvWarning ? { sessionEnvWarning: success.sessionEnvWarning } : {}),
        }
      } catch (err) {
        return { valid: false, error: toErrorMessage(err) }
      }
    },
  )

  // -------------------------------------------------------------------------
  // Detection: read-only metadata, no session write, nothing materialised
  // -------------------------------------------------------------------------
  ipcMain.handle(
    "google:env-credentials",
    async (
      _event,
      params: {
        prefix?: string
        defaultProject?: string
        source?: DetectionSource
        /**
         * Pins the gcloud configuration the 'gcloud' source reads. Accepted
         * ahead of the channel type, which currently only carries the active
         * configuration; absent, the active configuration is used.
         */
        configuration?: string
        /** Author `scopes` prop — required of user ADC when set. */
        scopes?: string[]
      } = {},
    ) => {
      const prefix = params.prefix || undefined
      const prefixError = invalidPrefixError(prefix)
      if (prefixError) return { found: false, error: prefixError }

      const source = params.source ?? "env"
      try {
        const resolved = await resolveDetectionSource(
          source,
          prefix,
          params.configuration,
          params.defaultProject,
        )
        if (!resolved) return { found: false, source }

        const metadata = {
          found: true,
          source: resolved.source,
          ...(resolved.credentialType ? { credentialType: resolved.credentialType } : {}),
          ...(resolved.envVar ? { envVar: resolved.envVar } : {}),
          ...(resolved.path ? { path: resolved.path } : {}),
          ...(resolved.configuration ? { configuration: resolved.configuration } : {}),
          ...(resolved.quotaProjectId ? { quotaProjectId: resolved.quotaProjectId } : {}),
        }

        try {
          const identity = await validateResolvedCredential(resolved)
          const projectId = resolved.projectId ?? identity.projectId
          const scopeFailure = scopeCheckFailure(identity, params.scopes)
          if (scopeFailure) {
            return {
              ...metadata,
              valid: false,
              account: toAccountInfo(identity),
              ...(projectId ? { projectId } : {}),
              ...(identity.projectName ? { projectName: identity.projectName } : {}),
              ...scopeFailure,
            }
          }
          return {
            ...metadata,
            valid: true,
            account: toAccountInfo(identity),
            ...(projectId ? { projectId } : {}),
            ...(identity.projectName ? { projectName: identity.projectName } : {}),
          }
        } catch (err) {
          // Found but unusable. The block owns the user-facing copy for each
          // source; the underlying reason rides along as a warning.
          return {
            ...metadata,
            valid: false,
            ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
            warning: toErrorMessage(err),
          }
        }
      } catch (err) {
        return { found: false, source, error: toErrorMessage(err) }
      }
    },
  )

  // Same detection, re-run at confirm time (the credential may have changed
  // between detect and confirm), but MAIN writes the session env. Metadata
  // only — unlike aws:env-credentials-confirm, which returns the raw keys.
  ipcMain.handle(
    "google:env-credentials-confirm",
    async (
      _event,
      params: {
        blockId?: string
        prefix?: string
        source?: DetectionSource
        configuration?: string
        projectId?: string
        region?: string
        zone?: string
        scopes?: string[]
      } = {},
    ) => {
      const prefix = params.prefix || undefined
      const prefixError = invalidPrefixError(prefix)
      if (prefixError) return { valid: false, error: prefixError }

      const source = params.source ?? "env"
      try {
        const resolved = await resolveDetectionSource(
          source,
          prefix,
          params.configuration,
          params.projectId,
        )
        if (!resolved) {
          return { valid: false, error: "No Google Cloud credentials found in environment variables" }
        }

        const identity = await validateResolvedCredential(resolved)
        const scopeFailure = scopeCheckFailure(identity, params.scopes)
        if (scopeFailure) {
          return {
            valid: false,
            account: toAccountInfo(identity),
            credentialType: identity.credentialType,
            ...scopeFailure,
          }
        }
        const projectId = params.projectId ?? resolved.projectId
        const region = params.region ?? resolved.region
        const zone = params.zone ?? resolved.zone

        const success = await registerAuthenticatedCredential({
          ...(params.blockId ? { blockId: params.blockId } : {}),
          identity,
          // Only inline JSON is materialised; a credential that is already a
          // file on disk is pointed at where it lives.
          ...(resolved.path ? { existingPath: resolved.path } : {}),
          ...(!resolved.path && resolved.documentJson ? { documentJson: resolved.documentJson } : {}),
          ...(resolved.accessToken ? { accessToken: resolved.accessToken } : {}),
          ...(projectId ? { projectId } : {}),
          ...(region ? { region } : {}),
          ...(zone ? { zone } : {}),
          ...(resolved.configuration ? { configuration: resolved.configuration } : {}),
        })

        return {
          valid: true,
          account: toAccountInfo(identity),
          ...(success.projectId ? { projectId: success.projectId } : {}),
          ...(success.credentialsPath ? { credentialsPath: success.credentialsPath } : {}),
          credentialType: identity.credentialType,
          ...(success.sessionEnvWarning ? { sessionEnvWarning: success.sessionEnvWarning } : {}),
        }
      } catch (err) {
        return { valid: false, error: toErrorMessage(err) }
      }
    },
  )

  // -------------------------------------------------------------------------
  // Project selection
  // -------------------------------------------------------------------------
  ipcMain.handle(
    "google:projects",
    async (
      _event,
      params: { blockId?: string; flowId?: string; query?: string; pageSize?: number } = {},
    ) => {
      const ref = await resolveCredentialRef(params.blockId, params.flowId)
      if (!ref) {
        return { projects: [], error: "No Google Cloud credentials available in this session" }
      }
      try {
        const projects = await runtime.runPromise(
          listProjects(ref, params.query, params.pageSize),
        )
        const mapped = projects.map(toProjectIpc)
        for (const project of mapped) projectDisplayNames.set(project.projectId, project.displayName)
        return { projects: mapped }
      } catch (err) {
        return { projects: [], error: toErrorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    "google:set-project",
    async (
      _event,
      params: { blockId?: string; projectId: string; region?: string; zone?: string },
    ) => {
      if (!params.projectId) return { ok: false, error: "No project selected" }
      try {
        const sessionEnvWarning = await appendGoogleSessionEnv(
          buildGoogleSessionEnv({
            projectId: params.projectId,
            ...(params.region ? { region: params.region } : {}),
            ...(params.zone ? { zone: params.zone } : {}),
          }),
        )

        // Only the CALLING block's credential is repointed — picking a project
        // in one GoogleAuth block must not rewrite another block's.
        const active = activeCredentialFor(params.blockId)
        if (active) {
          active.projectId = params.projectId
          if (params.region) active.region = params.region
          if (params.zone) active.zone = params.zone
        }

        const projectName = projectDisplayNames.get(params.projectId)
        return {
          ok: true,
          ...(projectName ? { projectName } : {}),
          ...(sessionEnvWarning ? { sessionEnvWarning } : {}),
        }
      } catch (err) {
        return { ok: false, error: toErrorMessage(err) }
      }
    },
  )

  // The aws:check-region analogue, and it FAILS OPEN like one: only a definite
  // "denied" produces a warning. A Resource Manager API that has not been
  // enabled, a scope-limited token, or a momentary network drop tells us
  // nothing about the project, and every gcloud/OpenTofu command in the runbook
  // may work fine — so it must not put a red herring on the success card.
  ipcMain.handle(
    "google:check-project",
    async (_event, params: { blockId?: string; projectId: string }) => {
      const ref = await resolveCredentialRef(params.blockId)
      if (!ref) {
        return {
          enabled: false,
          warning: "No Google Cloud credentials available to check project access",
        }
      }
      try {
        const access = await runtime.runPromise(checkProject(params.projectId, ref))
        if (access === "denied") {
          return {
            enabled: false,
            warning: `Project ${params.projectId} is not accessible with these credentials`,
          }
        }
        // "accessible" and "unknown" both read as enabled; only the former is
        // proof, and there is nothing useful to say about the latter.
        return { enabled: true }
      } catch (err) {
        // The credential itself could not be turned into a client — that is
        // worth saying out loud.
        return { enabled: false, warning: toErrorMessage(err) }
      }
    },
  )
}
