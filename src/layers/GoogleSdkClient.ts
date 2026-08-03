/**
 * Live implementation of the GoogleClient service using the official Google
 * auth library.
 *
 * This is the only module that may import that SDK or the node: APIs the Google
 * Cloud auth path needs. Everything above it goes through the `GoogleClient`
 * service tag.
 *
 * Nothing here shells out to the `gcloud` CLI: tokens are minted by the SDK and
 * gcloud's own on-disk state (ini configurations + the ADC JSON) is read
 * directly, exactly as AwsSdkClient reads `~/.aws/config`.
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as http from "node:http"
import { randomUUID, timingSafeEqual } from "node:crypto"
import { Effect, Layer } from "effect"
import { CodeChallengeMethod, GoogleAuth, JWT, OAuth2Client, UserRefreshClient } from "google-auth-library"
import type { AuthClient, ExternalAccountClientOptions } from "google-auth-library"
import { GoogleClient } from "../services/GoogleClient.ts"
import type {
  AdcInfo,
  GcloudConfiguration,
  GcloudConfigListing,
  GoogleClientShape,
  GoogleCredentialRef,
  GoogleCredentialType,
  GoogleIdentity,
  GoogleProject,
  GoogleProjectAccess,
  OAuthFlowResult,
  OAuthFlowStart,
  OAuthStartParams,
} from "../services/GoogleClient.ts"
import { GoogleAuthError, GoogleConfigError, GoogleOAuthError } from "../errors/index.ts"
import {
  classifyGcloudConfig,
  parseAdcDocument,
  parseGcloudConfiguration,
  resolveActiveConfigName,
  resolveGcloudConfigPaths,
} from "../domain/google/gcloud-config.ts"
import { assertFederatedCredentialAllowed } from "../domain/google/credential-policy.ts"

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const CRM_BASE = "https://cloudresourcemanager.googleapis.com/v3"
const MAX_PROJECTS = 500
const OAUTH_FLOW_TTL_MS = 5 * 60 * 1000

/**
 * How long a TERMINAL flow's result is kept for a poll that may never come.
 *
 * `pollOAuthFlow` normally collects a result within one 2s poll tick and
 * deletes the record. But a renderer that abandoned the flow (a poll loop that
 * timed out, a card that unmounted) never polls again, and a completed result
 * carries the long-lived `refresh_token` in `adcJson`. Nothing else reaps it,
 * so the flow record self-destructs shortly after going terminal.
 */
const OAUTH_RESULT_GRACE_MS = 30 * 1000

/** Every Google service account's email lives on this domain. */
const SERVICE_ACCOUNT_EMAIL_SUFFIX = ".gserviceaccount.com"

/** The one path the loopback listener answers; everything else is a 404. */
const OAUTH_CALLBACK_PATH = "/oauth2callback"

// ---------------------------------------------------------------------------
// Credentials documents
// ---------------------------------------------------------------------------

/**
 * The fields we read out of a Google credentials JSON document. Every shape
 * (service_account, authorized_user, external_account, impersonated) is a
 * subset of this, and the library branches on `type` at runtime.
 */
interface CredentialDocument {
  readonly type?: string
  readonly client_email?: string
  readonly client_id?: string
  readonly client_secret?: string
  readonly private_key?: string
  readonly project_id?: string
  readonly quota_project_id?: string
  readonly refresh_token?: string
}

/**
 * `JSON.parse` with a content-free failure message. Node's parser quotes the
 * offending text, and for a credentials document that text IS the secret — the
 * message would then travel out through the error's `message` field.
 */
function parseCredentialDocument(json: string, what: string): CredentialDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`${what} is not valid JSON`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} is not a JSON object`)
  }
  return parsed as CredentialDocument
}

/** Narrow a document's `type` string onto the service's credential-type union. */
function credentialTypeFromDocument(type: string | undefined): GoogleCredentialType {
  switch (type) {
    case "service_account":
    case "authorized_user":
    case "external_account":
    case "impersonated_service_account":
      return type
    // Workforce/workload pools hand out this variant; it authenticates exactly
    // like an external account.
    case "external_account_authorized_user":
      return "external_account"
    default:
      throw new Error(`Unsupported Google credentials type: ${type ?? "(missing)"}`)
  }
}

/**
 * A service-account key -> a JWT client. Constructed explicitly (never
 * `new GoogleAuth()` with no arguments) so ambient credentials can never be
 * validated in place of the caller's key.
 */
function jwtForKey(key: CredentialDocument): JWT {
  if (!key.client_email || !key.private_key) {
    throw new Error("Not a service account key (expected type: service_account)")
  }
  return new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [CLOUD_PLATFORM_SCOPE],
  })
}

interface DocumentClient {
  readonly client: AuthClient
  /**
   * Only present on the external/impersonated path — the one shape whose
   * project can be discovered by the library rather than read off the document.
   */
  readonly auth?: GoogleAuth
}

/** Build an auth client for any credentials document, branching on its `type`. */
async function clientForDocument(doc: CredentialDocument, rawJson: string): Promise<DocumentClient> {
  switch (credentialTypeFromDocument(doc.type)) {
    case "service_account":
      return { client: jwtForKey(doc) }
    case "authorized_user": {
      if (!doc.client_id || !doc.client_secret || !doc.refresh_token) {
        throw new Error(
          "Authorized-user credentials are missing client_id, client_secret, or refresh_token",
        )
      }
      return {
        client: new UserRefreshClient({
          clientId: doc.client_id,
          clientSecret: doc.client_secret,
          refreshToken: doc.refresh_token,
        }),
      }
    }
    default: {
      // external_account / impersonated_service_account. Unlike the two branches
      // above, these documents are instructions rather than data: they name the
      // URLs the library must call and the file it must read. Gate them BEFORE
      // the library sees them — google-auth-library performs no validation of
      // its own and its docs put that duty squarely on the caller.
      //
      // The object handed to the library is the one that was gated — re-parsing
      // after the check would leave room for the two to diverge.
      const credentials = JSON.parse(rawJson) as unknown
      assertFederatedCredentialAllowed(credentials)
      // The credentials are passed explicitly, so no ambient discovery (and no
      // GCE metadata probe) happens on the way to a token.
      const auth = new GoogleAuth({
        // An external-account document does not fit `JWTInput`; the library
        // reads `type` at runtime and picks the right client.
        credentials: credentials as ExternalAccountClientOptions,
        scopes: [CLOUD_PLATFORM_SCOPE],
      })
      return { client: await auth.getClient(), auth }
    }
  }
}

/** Turn a `GoogleCredentialRef` into an authorized client. */
async function authClientFor(ref: GoogleCredentialRef): Promise<AuthClient> {
  switch (ref.kind) {
    case "service_account":
      return jwtForKey(parseCredentialDocument(ref.keyJson, "The service account key"))
    case "authorized_user": {
      const doc = parseCredentialDocument(ref.adcJson, "The credentials document")
      return (await clientForDocument(doc, ref.adcJson)).client
    }
    case "access_token": {
      const client = new OAuth2Client()
      client.setCredentials({ access_token: ref.accessToken })
      return client
    }
    case "file": {
      const text = await fs.readFile(ref.path, "utf-8")
      const doc = parseCredentialDocument(text, `${ref.path}`)
      return (await clientForDocument(doc, text)).client
    }
  }
}

/**
 * Best-effort project display name. Mirrors the `ListAccountAliases` block in
 * AwsSdkClient: a credential without `resourcemanager.projects.get` still
 * authenticates fine, so a failure here must never fail the validate.
 */
async function lookupProjectName(
  client: AuthClient,
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!projectId) return undefined
  try {
    const resp = await client.request<{ displayName?: string }>({
      url: `${CRM_BASE}/projects/${encodeURIComponent(projectId)}`,
    })
    return resp.data.displayName
  } catch {
    // Project metadata lookup is best-effort
    return undefined
  }
}

/**
 * A service-account email is authoritative; the credential's own shape decides
 * the rest (tokeninfo omits `email` when the token lacks the email scope).
 */
function accountTypeFor(
  email: string,
  credentialType: GoogleCredentialType,
): "service_account" | "user" {
  if (email.endsWith(SERVICE_ACCOUNT_EMAIL_SUFFIX)) return "service_account"
  return credentialType === "service_account" || credentialType === "impersonated_service_account"
    ? "service_account"
    : "user"
}

/**
 * The `GetCallerIdentity` analogue for every token-shaped credential: ask the
 * oauth2 tokeninfo endpoint who the token belongs to.
 */
async function identityFromAccessToken(
  accessToken: string,
  credentialType: GoogleCredentialType,
  projectId: string | undefined,
  emailHint?: string,
): Promise<GoogleIdentity> {
  const client = new OAuth2Client()
  const info = await client.getTokenInfo(accessToken)
  const email = info.email ?? emailHint ?? ""

  // Reuse the same client for the enrichment call, now carrying the token.
  client.setCredentials({ access_token: accessToken })

  return {
    email,
    uniqueId: info.sub ?? info.user_id,
    accountType: accountTypeFor(email, credentialType),
    credentialType,
    projectId,
    projectName: await lookupProjectName(client, projectId),
    scopes: info.scopes,
  }
}

/** Read an on-disk credentials JSON as metadata. Missing/unusable => undefined. */
async function readAdcMetadata(filePath: string): Promise<AdcInfo | undefined> {
  let text: string
  try {
    text = await fs.readFile(filePath, "utf-8")
  } catch {
    // ADC file may not exist (`gcloud auth application-default login` unrun)
    return undefined
  }
  try {
    return parseAdcDocument(filePath, text)
  } catch {
    // A malformed or unsupported document reads as "no ADC" rather than
    // failing the whole listing.
    return undefined
  }
}

// ---------------------------------------------------------------------------
// OAuth loopback flow (RFC 8252 + PKCE S256)
// ---------------------------------------------------------------------------

/**
 * Layer-local state with no AwsSdkClient precedent: the AWS device flow is
 * stateless, but a loopback listener is a live OS resource that has to survive
 * between `startOAuthFlow` and `pollOAuthFlow`.
 */
interface PendingFlow {
  status: OAuthFlowResult["status"]
  /** The terminal payload, delivered by `pollOAuthFlow` exactly once. */
  result?: OAuthFlowResult
  server?: http.Server
  client?: OAuth2Client
  timer?: ReturnType<typeof setTimeout>
  /** Drops the record (and the refresh token in `result`) if nobody collects it. */
  reaper?: ReturnType<typeof setTimeout>
  readonly clientId: string
  readonly clientSecret?: string
  readonly state: string
  readonly codeVerifier: string
  readonly redirectUri: string
  readonly scopes: string[]
}

const pendingFlows = new Map<string, PendingFlow>()

const CALLBACK_PAGE = (heading: string, body: string): string =>
  // Static copy only — a callback page must never reflect a query parameter.
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<title>Gruntwork Runbooks</title></head>` +
  `<body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center">` +
  `<h1 style="font-size:1.25rem">${heading}</h1><p>${body}</p></body></html>`

const SUCCESS_PAGE = CALLBACK_PAGE(
  "Signed in to Google Cloud",
  "You can close this tab and return to Runbooks.",
)
const DENIED_PAGE = CALLBACK_PAGE(
  "Sign-in was not completed",
  "You can close this tab and return to Runbooks.",
)

/**
 * Write a static page and resolve only once it has been flushed — the caller
 * tears the listener down immediately afterwards, and a socket destroyed
 * mid-write would leave the user staring at a browser error.
 */
function respond(res: http.ServerResponse, status: number, html: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    // "close" covers a client that walked away before the flush completed.
    res.on("close", settle)
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Let the socket go so `server.close()` can actually finish.
      Connection: "close",
    })
    res.end(html, settle)
  })
}

/** Length-safe constant-time comparison of two ASCII strings. */
function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Close the listener, drop the timer, and release the flow's secret material. */
function closeFlowResources(flow: PendingFlow): void {
  if (flow.timer) {
    clearTimeout(flow.timer)
    flow.timer = undefined
  }
  if (flow.reaper) {
    clearTimeout(flow.reaper)
    flow.reaper = undefined
  }
  const server = flow.server
  if (server) {
    flow.server = undefined
    try {
      // Keep-alive sockets would otherwise hold the listener open.
      server.closeAllConnections()
      server.close()
    } catch {
      // Already closed
    }
  }
  // The client holds the OAuth client secret and the exchanged tokens.
  flow.client = undefined
}

/**
 * Move a flow to its terminal state. The first terminal result wins, so exactly
 * one callback is ever accepted and every exit path (success, error, cancel,
 * timeout) closes the listener.
 */
function finishFlow(flowId: string, result: OAuthFlowResult): void {
  const flow = pendingFlows.get(flowId)
  if (!flow || flow.status !== "pending") return
  flow.status = result.status
  flow.result = result
  closeFlowResources(flow)

  // Nobody may ever poll for this: a renderer whose poll loop already gave up
  // (or whose block unmounted) will not ask again, and `result.adcJson` holds a
  // long-lived refresh token. Drop the record after a short grace period so a
  // normal poll still collects it but an abandoned one cannot linger for the
  // life of the process.
  const reaper = setTimeout(() => {
    pendingFlows.delete(flowId)
  }, OAUTH_RESULT_GRACE_MS)
  reaper.unref()
  flow.reaper = reaper
}

/** The request-shape fields the origin check reads. Structural, so it is testable. */
export interface CallbackRequestShape {
  readonly method?: string | undefined
  readonly headers: {
    readonly host?: string | undefined
    readonly "sec-fetch-dest"?: string | string[] | undefined
    readonly "sec-fetch-mode"?: string | string[] | undefined
  }
}

/**
 * Whether a request could plausibly BE Google's redirect landing in the user's
 * browser, as opposed to unauthenticated noise aimed at the loopback port.
 *
 * The listener is bound to an ephemeral 127.0.0.1 port, which any web page the
 * user has open can reach: `fetch('http://127.0.0.1:'+p+'/oauth2callback',
 * {mode:'no-cors'})` across the ephemeral range costs a page nothing and does
 * not require the response to be readable. Loopback is a potentially-trustworthy
 * origin, so mixed-content blocking does not stop it. These checks drop that
 * traffic before it can touch the flow at all:
 *
 *  - Google's redirect is always a GET; nothing else is.
 *  - The `Host` header of a real callback is the literal `127.0.0.1:<port>` we
 *    published. A DNS-rebound request carries the attacker's hostname instead.
 *  - `Sec-Fetch-Dest: document` + `Sec-Fetch-Mode: navigate` are what a browser
 *    sends on a TOP-LEVEL navigation. An `<img>` probe sends `image`/`no-cors`
 *    and a `fetch` probe sends `empty`/`no-cors`.
 *
 * The fetch-metadata headers are checked only when PRESENT: a browser too old
 * to send them, or a user pasting the URL into curl, must still be able to
 * complete a sign-in. `Sec-Fetch-Site` is deliberately NOT checked — the
 * redirect back from accounts.google.com is a cross-site navigation, so
 * requiring `none`/`same-origin` there would reject every real callback.
 */
export function isPlausibleOAuthCallback(req: CallbackRequestShape, expectedHost: string): boolean {
  if ((req.method ?? "GET").toUpperCase() !== "GET") return false

  const host = req.headers.host
  if (!host || host.toLowerCase() !== expectedHost.toLowerCase()) return false

  // A repeated fetch-metadata header is not something a browser produces.
  const dest = req.headers["sec-fetch-dest"]
  if (dest !== undefined && dest !== "document") return false

  const mode = req.headers["sec-fetch-mode"]
  if (mode !== undefined && mode !== "navigate") return false

  return true
}

async function handleOAuthCallback(
  flowId: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const flow = pendingFlows.get(flowId)
  if (!flow || !flow.client || flow.status !== "pending") {
    await respond(res, 404, DENIED_PAGE)
    return
  }

  // Everything from here to the state check is UNAUTHENTICATED input: it must
  // be able to end the request, never the flow. Only the TTL, the user, or a
  // callback that proves it knows `state` may move the flow to a terminal
  // state — otherwise one stray GET from any page the user has open is a
  // reliable denial of Google sign-in.
  const expectedHost = new URL(flow.redirectUri).host
  if (!isPlausibleOAuthCallback(req, expectedHost)) {
    await respond(res, 404, DENIED_PAGE)
    return
  }

  let url: URL
  try {
    url = new URL(req.url ?? "/", flow.redirectUri)
  } catch {
    // A request target `URL` cannot parse. The handler runs detached
    // (`void handleOAuthCallback(...)`), so a throw here would surface as an
    // unhandled rejection in main rather than as a 400.
    await respond(res, 400, DENIED_PAGE)
    return
  }
  // An absolute-form request target carries its own authority, which `URL`
  // prefers over the base. It has to match the one we published too.
  if (url.host.toLowerCase() !== expectedHost.toLowerCase()) {
    await respond(res, 404, DENIED_PAGE)
    return
  }
  if (url.pathname !== OAUTH_CALLBACK_PATH) {
    // Favicon probes and stray requests must not consume the flow.
    await respond(res, 404, DENIED_PAGE)
    return
  }

  if (!constantTimeEquals(url.searchParams.get("state") ?? "", flow.state)) {
    // Same class as a wrong path, and treated the same way: answer the request
    // and keep listening. An attacker cannot produce a valid `state`, so failing
    // the flow here would only ever hurt the user whose sign-in is in flight —
    // including the entirely accidental cases (a reloaded callback tab from an
    // earlier flow, a browser prefetch, a local port scanner).
    await respond(res, 400, DENIED_PAGE)
    return
  }

  const denied = url.searchParams.get("error")
  if (denied) {
    await respond(res, 200, DENIED_PAGE)
    finishFlow(flowId, { status: "failed", error: `Google sign-in was denied (${denied})` })
    return
  }

  const code = url.searchParams.get("code")
  if (!code) {
    await respond(res, 400, DENIED_PAGE)
    finishFlow(flowId, { status: "failed", error: "The OAuth callback carried no authorization code" })
    return
  }

  try {
    const { tokens } = await flow.client.getToken({
      code,
      codeVerifier: flow.codeVerifier,
      redirect_uri: flow.redirectUri,
    })
    if (!tokens.refresh_token) {
      throw new Error(
        "Google returned no refresh token. Revoke Runbooks' access at " +
          "https://myaccount.google.com/permissions and sign in again.",
      )
    }

    // A long-lived authorized_user document, NOT a bare bearer token: client
    // libraries, gcloud, and the Terraform provider all refresh from this file
    // themselves, so the credential cannot go stale mid-runbook.
    const adcJson = JSON.stringify(
      {
        type: "authorized_user",
        client_id: flow.clientId,
        client_secret: flow.clientSecret ?? "",
        refresh_token: tokens.refresh_token,
      },
      null,
      2,
    )
    const scopes = tokens.scope ? tokens.scope.split(" ") : [...flow.scopes]

    await respond(res, 200, SUCCESS_PAGE)
    finishFlow(flowId, {
      status: "complete",
      adcJson,
      accessToken: tokens.access_token ?? undefined,
      scopes,
    })
  } catch (err) {
    await respond(res, 500, DENIED_PAGE)
    finishFlow(flowId, { status: "failed", error: `Failed to exchange the authorization code: ${err}` })
  }
}

// ---------------------------------------------------------------------------
// Cloud Resource Manager
// ---------------------------------------------------------------------------

/** The subset of a CRM v3 project we surface. */
interface CrmProject {
  readonly name?: string | null
  readonly projectId?: string | null
  readonly displayName?: string | null
  readonly state?: string | number | null
}

interface CrmSearchResponse {
  readonly projects?: CrmProject[]
  readonly nextPageToken?: string
}

function toGoogleProject(project: CrmProject): GoogleProject {
  const projectId = project.projectId ?? ""
  return {
    projectId,
    displayName: project.displayName ?? projectId,
    // `name` is "projects/<projectNumber>".
    projectNumber: project.name?.split("/")[1],
    state: typeof project.state === "string" ? project.state : undefined,
  }
}

/**
 * `projects:search` over plain REST rather than `ProjectsClient`.
 *
 * The generated client's `authClient` option is typed against the
 * google-auth-library that google-gax bundles (v10), which structurally rejects
 * the v11 `AuthClient` we hold — the escape hatch the plan reserves for exactly
 * this. It also keeps `google-gax`/`@grpc/grpc-js`/`protobufjs` and their
 * runtime proto loading out of the auth path inside Electron. Same auth object,
 * same endpoint, identical result mapping.
 */
/**
 * Whether a project should be offered in the picker.
 *
 * `projects:search` returns projects pending deletion (DELETE_REQUESTED)
 * alongside live ones, and they are indistinguishable in the list. Binding a
 * runbook to a project that is being torn down only produces confusing
 * downstream failures, so drop them — this is what `gcloud projects list` does
 * by default. A project whose state the API omitted is kept rather than guessed
 * at, matching the fail-open discipline in classifyProjectAccessError.
 */
export function isSelectableProject(project: GoogleProject): boolean {
  return !project.state || project.state === "ACTIVE"
}

async function searchProjects(
  authClient: AuthClient,
  query: string | undefined,
  limit: number,
): Promise<GoogleProject[]> {
  const projects: GoogleProject[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams()
    if (query) params.set("query", query)
    params.set("pageSize", String(Math.min(limit - projects.length, 1000)))
    if (pageToken) params.set("pageToken", pageToken)

    const resp = await authClient.request<CrmSearchResponse>({
      url: `${CRM_BASE}/projects:search?${params.toString()}`,
    })

    for (const project of resp.data.projects ?? []) {
      const candidate = toGoogleProject(project)
      if (!isSelectableProject(candidate)) continue
      projects.push(candidate)
      if (projects.length >= limit) return projects
    }
    pageToken = resp.data.nextPageToken
  } while (pageToken)

  return projects
}

/**
 * Google's own machine-readable failure reasons that mean "the API could not
 * answer", NOT "you cannot see this project". They arrive as 403s alongside
 * genuine permission denials, so the status code alone cannot separate them.
 */
const INCONCLUSIVE_ERROR_STATUSES = new Set([
  "SERVICE_DISABLED",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "INTERNAL",
  "DEADLINE_EXCEEDED",
  "ABORTED",
  "UNAUTHENTICATED",
])

/** The shape a Gaxios/Google API error exposes, as far as we read it. */
interface GoogleApiError {
  readonly status?: number
  readonly code?: number | string
  readonly response?: {
    readonly status?: number
    readonly data?: { readonly error?: { readonly status?: string; readonly message?: string } }
  }
}

/**
 * Turn a failed `projects.get` into a verdict.
 *
 * Only an answer that names THIS project as missing or forbidden counts as
 * `denied`. Everything else — a Cloud Resource Manager API that was never
 * enabled (Google's default for new projects), a token minted without the
 * cloud-platform scope, a 5xx, a dropped connection — is `unknown`, because a
 * runbook full of working gcloud commands must not be told its project is
 * inaccessible.
 */
/**
 * Turn a token-endpoint failure into copy a runbook user can act on.
 *
 * google-auth-library stringifies OAuth failures as the raw JSON body, so the
 * default `${err}` surfaces `{"error":"invalid_grant","error_subtype":
 * "invalid_rapt"}` in the block. Google's own CLI answers the same condition
 * with the exact command to run, and so should we — a stale ADC file is the
 * single most common way this block fails, and the fix is one command.
 *
 * Returns undefined when the failure is not a recognised OAuth condition, so
 * the caller keeps its existing message.
 */
export function describeCredentialFailure(
  err: unknown,
  kind: "adc" | "service_account" | "access_token" = "adc",
): string | undefined {
  const text = err instanceof Error ? err.message : String(err ?? "")

  // Reauth: the refresh token is live but the org's reauth policy wants the
  // human back. Distinct from a dead grant, and distinctly fixable.
  if (/invalid_rapt|reauth/i.test(text)) {
    return kind === "adc"
      ? "Your Application Default Credentials need reauthentication. Run `gcloud auth application-default login` to refresh them."
      : "This credential needs reauthentication before it can be used."
  }
  if (/invalid_grant/i.test(text)) {
    if (kind === "service_account") {
      return "This service account key has been disabled, deleted, or revoked. Generate a new key, or check that the service account still exists."
    }
    if (kind === "access_token") {
      return "This access token has expired or been revoked."
    }
    return "Your Application Default Credentials have expired or been revoked. Run `gcloud auth application-default login` to refresh them."
  }
  if (/invalid_client|unauthorized_client/i.test(text)) {
    return "The OAuth client is not valid for this credential. Check the `oauthClientId` and `oauthClientSecret` props."
  }
  if (/invalid_scope/i.test(text)) {
    return "The credential was refused the scopes this block requires (cloud-platform)."
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return "Could not reach Google's authentication servers. Check your network connection or proxy settings."
  }
  return undefined
}

export function classifyProjectAccessError(err: unknown): GoogleProjectAccess {
  const apiError = (err ?? {}) as GoogleApiError
  const httpStatus =
    apiError.status ??
    apiError.response?.status ??
    (typeof apiError.code === "number" ? apiError.code : undefined)
  const reason = apiError.response?.data?.error?.status

  if (reason && INCONCLUSIVE_ERROR_STATUSES.has(reason)) return "unknown"
  if (httpStatus === 404) return "denied"
  if (httpStatus === 403) {
    // A 403 with no machine-readable reason is overwhelmingly a permission
    // denial on the project; the named inconclusive reasons were filtered out
    // above.
    return reason === undefined || reason === "PERMISSION_DENIED" ? "denied" : "unknown"
  }
  return "unknown"
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

const impl: GoogleClientShape = {
  validateServiceAccountKey: (keyJson: string, projectIdOverride?: string) =>
    Effect.tryPromise({
      try: async (): Promise<GoogleIdentity> => {
        const key = parseCredentialDocument(keyJson, "The service account key")
        if (key.type !== "service_account" || !key.client_email || !key.private_key || !key.project_id) {
          throw new Error("Not a service account key (expected type: service_account)")
        }

        // Mint a real token — this is the GetCallerIdentity analogue. A key
        // that parses but has been disabled or revoked fails right here.
        const jwt = jwtForKey(key)
        await jwt.authorize()

        const projectId = projectIdOverride ?? key.project_id
        return {
          email: key.client_email,
          uniqueId: key.client_id,
          accountType: "service_account",
          credentialType: "service_account",
          projectId,
          projectName: await lookupProjectName(jwt, projectId),
          scopes: [CLOUD_PLATFORM_SCOPE],
        }
      },
      catch: (err) =>
        new GoogleAuthError({
          message:
            describeCredentialFailure(err, "service_account") ??
            `Failed to validate service account key: ${err}`,
          cause: err,
        }),
    }),

  validateAccessToken: (accessToken: string, projectIdOverride?: string) =>
    Effect.tryPromise({
      try: (): Promise<GoogleIdentity> =>
        identityFromAccessToken(accessToken, "access_token", projectIdOverride),
      catch: (err) =>
        new GoogleAuthError({
          message:
            describeCredentialFailure(err, "access_token") ??
            `Failed to validate access token: ${err}`,
          cause: err,
        }),
    }),

  validateAdcDocument: (adcJson: string, projectIdOverride?: string) =>
    Effect.tryPromise({
      try: async (): Promise<GoogleIdentity> => {
        const doc = parseCredentialDocument(adcJson, "The credentials document")
        const credentialType = credentialTypeFromDocument(doc.type)
        const { client, auth } = await clientForDocument(doc, adcJson)

        const { token } = await client.getAccessToken()
        if (!token) {
          throw new Error("The credentials document did not yield an access token")
        }

        let projectId = projectIdOverride ?? doc.quota_project_id ?? doc.project_id
        if (!projectId && auth) {
          try {
            projectId = await auth.getProjectId()
          } catch {
            // External accounts need not carry a project; the picker handles it
          }
        }

        return identityFromAccessToken(token, credentialType, projectId, doc.client_email)
      },
      catch: (err) =>
        new GoogleAuthError({
          message: describeCredentialFailure(err, "adc") ?? `Failed to validate credentials: ${err}`,
          cause: err,
        }),
    }),

  readCredentialFile: (filePath: string) =>
    Effect.tryPromise({
      try: async (): Promise<AdcInfo> => {
        const text = await fs.readFile(filePath, "utf-8")
        try {
          return parseAdcDocument(filePath, text)
        } catch {
          // Never echo the parser's message: it quotes the file's contents.
          throw new Error(`${filePath} is not a valid Google credentials document`)
        }
      },
      catch: (err) => new GoogleConfigError({ message: `Failed to read credentials file: ${err}` }),
    }),

  readCredentialFileContents: (filePath: string) =>
    Effect.tryPromise({
      try: (): Promise<string> => fs.readFile(filePath, "utf-8"),
      catch: (err) => new GoogleConfigError({ message: `Failed to read credentials file: ${err}` }),
    }),

  listGcloudConfigurations: () =>
    Effect.tryPromise({
      try: async (): Promise<GcloudConfigListing> => {
        const paths = resolveGcloudConfigPaths(process.env, os.homedir(), process.platform)

        let activeConfigText: string | undefined
        try {
          activeConfigText = await fs.readFile(paths.activeConfigFile, "utf-8")
        } catch {
          // active_config may not exist — a fresh install only has "default"
        }
        const activeConfiguration = resolveActiveConfigName(process.env, activeConfigText)

        // One ADC document backs every configuration: gcloud stores CLI
        // credentials in credentials.db (SQLite, unreadable here) and only
        // application_default_credentials.json is a supportable credential.
        const adc = await readAdcMetadata(paths.adcFile)

        let entries: string[] = []
        try {
          entries = await fs.readdir(paths.configurationsDir)
        } catch {
          // Configurations directory may not exist
        }

        const configurations: GcloudConfiguration[] = []
        for (const entry of entries.sort()) {
          const match = /^config_(.+)$/.exec(entry)
          if (!match) continue
          const name = match[1]

          let text: string
          try {
            text = await fs.readFile(path.join(paths.configurationsDir, entry), "utf-8")
          } catch {
            // Configuration file may have vanished between readdir and read
            continue
          }

          const fields = parseGcloudConfiguration(text)
          configurations.push({
            name,
            isActive: name === activeConfiguration,
            ...fields,
            authType: classifyGcloudConfig(fields, adc),
          })
        }

        return {
          configurations,
          activeConfiguration,
          configRoot: paths.root,
          ...(adc ? { adc } : {}),
        }
      },
      catch: (err) => new GoogleConfigError({ message: `Failed to list gcloud configurations: ${err}` }),
    }),

  readApplicationDefaultCredentials: () =>
    Effect.tryPromise({
      try: async (): Promise<AdcInfo | undefined> => {
        const paths = resolveGcloudConfigPaths(process.env, os.homedir(), process.platform)
        const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
        const candidates = fromEnv ? [fromEnv, paths.adcFile] : [paths.adcFile]
        for (const candidate of candidates) {
          const info = await readAdcMetadata(candidate)
          if (info) return info
        }
        return undefined
      },
      catch: (err) =>
        new GoogleConfigError({ message: `Failed to read application default credentials: ${err}` }),
    }),

  startOAuthFlow: (params: OAuthStartParams) =>
    Effect.tryPromise({
      try: async (): Promise<OAuthFlowStart> => {
        if (!params.clientId) {
          throw new Error("OAuth login is not configured for this build")
        }

        // Distinct from `state`, and generated up front so the listener's own
        // error handler can fail the flow rather than crash the main process.
        const flowId = randomUUID()

        const server = http.createServer()
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          // Explicitly 127.0.0.1: "localhost" may resolve to ::1 and mismatch
          // the redirect URI, and 0.0.0.0 would expose the listener.
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject)
            // A server with no "error" listener throws, and an unhandled
            // 'error' event in main is fatal.
            server.on("error", (err) => {
              finishFlow(flowId, {
                status: "failed",
                error: `The sign-in listener failed: ${err.message}`,
              })
            })
            resolve()
          })
        })

        // From here on the listener is live: any failure has to close it, or an
        // abandoned socket leaks for the life of the process.
        try {
          const address = server.address()
          const port = typeof address === "object" && address !== null ? address.port : 0
          if (!port) {
            throw new Error("Failed to bind a loopback port for the OAuth redirect")
          }

          const redirectUri = `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`
          const client = new OAuth2Client({
            clientId: params.clientId,
            clientSecret: params.clientSecret,
            redirectUri,
          })

          // PKCE S256. The verifier, the state nonce, and the client secret all
          // stay in this process — only `flowId` ever crosses IPC.
          const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
          const state = randomUUID()
          const scopes = [...params.scopes]

          const authUrl = client.generateAuthUrl({
            // offline + consent are what guarantee a refresh token comes back,
            // which the long-lived credentials file depends on.
            access_type: "offline",
            prompt: "consent",
            scope: scopes,
            code_challenge_method: CodeChallengeMethod.S256,
            code_challenge: codeChallenge,
            state,
            ...(params.loginHint ? { login_hint: params.loginHint } : {}),
          })

          const flow: PendingFlow = {
            status: "pending",
            server,
            client,
            clientId: params.clientId,
            clientSecret: params.clientSecret,
            state,
            codeVerifier,
            redirectUri,
            scopes,
          }
          flow.timer = setTimeout(() => {
            finishFlow(flowId, { status: "expired", error: "The Google sign-in window expired" })
          }, OAUTH_FLOW_TTL_MS)
          // An abandoned flow must never hold the process open.
          flow.timer.unref()

          pendingFlows.set(flowId, flow)
          server.on("request", (req, res) => {
            void handleOAuthCallback(flowId, req, res)
          })

          return {
            flowId,
            authUrl,
            redirectUri,
            expiresInSeconds: Math.floor(OAUTH_FLOW_TTL_MS / 1000),
          }
        } catch (err) {
          server.closeAllConnections()
          server.close()
          throw err
        }
      },
      catch: (err) =>
        new GoogleOAuthError({ message: `Failed to start Google sign-in: ${err}`, cause: err }),
    }),

  pollOAuthFlow: (flowId: string) =>
    Effect.tryPromise({
      try: async (): Promise<OAuthFlowResult> => {
        const flow = pendingFlows.get(flowId)
        if (!flow) {
          return {
            status: "failed",
            error: "Unknown sign-in flow — it may have already completed, expired, or been cancelled",
          }
        }
        if (flow.status === "pending") return { status: "pending" }

        // Terminal results are delivered exactly once: the refresh token in
        // `adcJson` must not linger in this process after main has it.
        const result = flow.result ?? { status: flow.status }
        if (flow.reaper) {
          clearTimeout(flow.reaper)
          flow.reaper = undefined
        }
        pendingFlows.delete(flowId)
        return result
      },
      catch: (err) =>
        new GoogleOAuthError({ message: `Failed to poll Google sign-in: ${err}`, cause: err }),
    }),

  cancelOAuthFlow: (flowId: string) =>
    // No error channel on this method: cancelling is best-effort cleanup.
    Effect.sync(() => {
      const flow = pendingFlows.get(flowId)
      if (!flow) return
      closeFlowResources(flow)
      pendingFlows.delete(flowId)
    }),

  listProjects: (creds: GoogleCredentialRef, query?: string, pageSize?: number) =>
    Effect.tryPromise({
      try: async (): Promise<GoogleProject[]> => {
        const authClient = await authClientFor(creds)
        const limit = Math.max(1, Math.min(pageSize ?? MAX_PROJECTS, MAX_PROJECTS))
        return searchProjects(authClient, query, limit)
      },
      catch: (err) => new GoogleAuthError({ message: `Failed to list projects: ${err}`, cause: err }),
    }),

  checkProject: (projectId: string, creds: GoogleCredentialRef) =>
    Effect.tryPromise({
      try: async (): Promise<GoogleProjectAccess> => {
        // A credential that cannot even build a client is a real failure and
        // propagates; everything the REQUEST can tell us is classified instead.
        const authClient = await authClientFor(creds)
        try {
          await authClient.request({ url: `${CRM_BASE}/projects/${encodeURIComponent(projectId)}` })
          return "accessible"
        } catch (err) {
          return classifyProjectAccessError(err)
        }
      },
      catch: (err) => new GoogleAuthError({ message: `Failed to check project: ${err}`, cause: err }),
    }),
}

export const GoogleSdkClientLive = Layer.succeed(GoogleClient, impl)
