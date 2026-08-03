/**
 * Safety gate for FEDERATED Google credential documents.
 *
 * Strings in, throws out — no I/O, no `node:` imports, no SDKs, exactly like
 * `gcloud-config.ts`.
 *
 * ## Why this module exists
 *
 * A `service_account` key and an `authorized_user` document are inert data: the
 * layer builds a `JWT` / `UserRefreshClient` from named fields it reads itself,
 * so nothing in the document can steer where a request goes.
 *
 * `external_account`, `external_account_authorized_user` and
 * `impersonated_service_account` are NOT inert. They are little programs: the
 * document names the URLs google-auth-library must call, the headers it must
 * send, and (via `credential_source`) the local file it must read or the
 * executable it must run. Handing an unvalidated one to the library turns any
 * credential JSON a user pastes into
 *
 *   - an arbitrary outbound HTTP request from the unsandboxed Electron main
 *     process (cloud metadata, intranet hosts, localhost admin ports), and
 *   - an arbitrary local-file read whose contents are POSTed to a host the
 *     document chose.
 *
 * google-auth-library ships no defence of its own — the `validateGoogleAPIsUrl`
 * check that older majors performed on `token_url` is gone, and its own docs
 * say the caller "must validate it before providing it to any Google API or
 * library". This module is that validation.
 *
 * ## The policy
 *
 * 1. Every absolute URL anywhere in the document must be `https:` and must
 *    resolve to a host under `googleapis.com`. That single rule covers
 *    `token_url`, `token_info_url`, `service_account_impersonation_url`,
 *    `cloud_resource_manager_url`, the impersonated client's `endpoint`
 *    override, and any URL-valued field a future library version adds.
 * 2. `universe_domain` must be `googleapis.com`. The library interpolates it
 *    into the DEFAULT token URL (`https://sts.{universeDomain}/v1/token`), so
 *    leaving it free re-opens rule 1 through the back door.
 * 3. `credential_source` is rejected outright — see below.
 * 4. `source_credentials` (the `impersonated_service_account` chain) is
 *    re-validated under the same rules, and may only name a credential type
 *    that is itself safe to build.
 *
 * ## Why `credential_source` is rejected rather than filtered
 *
 * Its four shapes are exactly the dangerous primitives: `url` + `headers` is a
 * verbatim attacker-controlled GET, `executable` runs a program, `aws1`
 * environment sourcing opens four more attacker-named URLs, and `file` reads
 * any path on disk. Rule 1 stops the *exfiltration* of a file-sourced subject
 * token to a third party, but a `file` source would still ship the victim's
 * `~/.ssh/id_rsa` to Google's STS endpoint, which is not a trade a credentials
 * dialog should be able to make.
 *
 * Nothing a desktop user actually signs in with needs it: workforce-pool login
 * (`gcloud auth application-default login`) writes an
 * `external_account_authorized_user` document that carries a refresh token and
 * no `credential_source`, and `impersonated_service_account` sources its
 * credentials from the nested document. Only file/URL/executable-sourced
 * *workload* identity federation — a CI and VM pattern — is excluded.
 *
 * If that ever has to ship, the safe re-enablement is narrow and lives in
 * `assertCredentialSource` alone: permit `{ file, format }` and only for a path
 * the app itself resolved, never one that arrived inside a document the
 * renderer supplied.
 */

/** Every Google API endpoint lives under this domain. */
const GOOGLE_API_DOMAIN = "googleapis.com"

/**
 * The credential types whose behaviour the document itself controls. Everything
 * else the layer builds from named fields, so there is nothing to steer.
 */
const FEDERATED_TYPES: ReadonlySet<string> = new Set([
  "external_account",
  "external_account_authorized_user",
  "impersonated_service_account",
])

/**
 * Types an `impersonated_service_account` may chain to.
 *
 * `gdch_service_account` is deliberately absent: google-auth-library builds a
 * `GdchClient` from it and that client DOES honour the document's own
 * `token_uri`, which would reintroduce rule 1's hole one level down.
 */
const CHAINABLE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "service_account",
  "authorized_user",
  "external_account",
  "external_account_authorized_user",
  "impersonated_service_account",
])

/**
 * A scheme followed by an authority. Deliberately NOT a URL parse: `audience`
 * is `//iam.googleapis.com/projects/...` (no scheme) and `subject_token_type`
 * is `urn:ietf:params:oauth:token-type:jwt` (no authority); neither is a
 * request target and neither may be treated as one.
 */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Normalise a candidate the way the WHATWG URL parser will, BEFORE deciding
 * whether it is a request target.
 *
 * The parser strips leading/trailing C0-or-space and removes every embedded
 * tab/CR/LF as its first act, so `" http://attacker/"` and `"ht\ntps://attacker/"`
 * are perfectly good URLs to `new URL` and to gaxios — but neither matches an
 * anchored scheme regex. Testing the raw string therefore let a hostile
 * `token_url` skip this whole module by prepending one space.
 *
 * Both the test AND the subsequent parse must use the normalised form, or the
 * detector and the parser disagree again one layer down.
 */
function normaliseUrlCandidate(value: string): string {
  // Done by character code rather than a regex: matching C0 controls is the
  // whole point here, and a regex that does it trips `no-control-regex`.
  let start = 0
  let end = value.length
  while (start < end && value.charCodeAt(start) <= 0x20) start++
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--

  let out = ""
  for (let i = start; i < end; i++) {
    const code = value.charCodeAt(i)
    // tab, LF, CR - removed anywhere in the string, not just at the ends.
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    out += value[i]
  }
  return out
}

/** Guard against a self-referential document walking us into a stack overflow. */
const MAX_DEPTH = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Hosts outside `googleapis.com` that appear in a legitimate, unmodified Google
 * credentials document. `auth_uri` in every service-account key Google issues is
 * `https://accounts.google.com/o/oauth2/auth`, and a nested key would otherwise
 * fail the chained sweep. Exact matches only — no subdomains, because
 * `*.google.com` is far too much surface to trust.
 */
const EXTRA_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["accounts.google.com"])

/** `googleapis.com` itself, or any subdomain of it. Never a suffix match. */
function isGoogleApiHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === GOOGLE_API_DOMAIN || host.endsWith(`.${GOOGLE_API_DOMAIN}`) || EXTRA_ALLOWED_HOSTS.has(host)
  )
}

/**
 * One URL-valued field. Parsed with `URL` so that userinfo tricks
 * (`https://sts.googleapis.com@attacker.example/`) are read the way the HTTP
 * client will read them, not the way they look.
 */
function assertGoogleApiUrl(value: string, field: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`The credentials document field "${field}" is not a valid URL`)
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `The credentials document field "${field}" must be an https:// URL (found "${url.protocol}//")`,
    )
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`The credentials document field "${field}" must not embed credentials in the URL`)
  }
  if (!isGoogleApiHost(url.hostname)) {
    throw new Error(
      `The credentials document field "${field}" points at "${url.hostname}", which is not a Google ` +
        `API endpoint. Runbooks only accepts federated credentials that talk to *.${GOOGLE_API_DOMAIN}.`,
    )
  }
}

/** Recursively assert that no value anywhere under `value` is a non-Google URL. */
function assertNoForeignUrls(value: unknown, field: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new Error("The credentials document is nested too deeply to validate")
  }
  if (typeof value === "string") {
    const candidate = normaliseUrlCandidate(value)
    if (ABSOLUTE_URL.test(candidate)) assertGoogleApiUrl(candidate, field)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoForeignUrls(entry, `${field}[${index}]`, depth + 1)
    })
    return
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoForeignUrls(entry, field ? `${field}.${key}` : key, depth + 1)
    }
  }
}

/**
 * `credential_source` is the document's "go and fetch the subject token from
 * here" instruction. Every shape of it is a capability Runbooks will not hand
 * to a pasted file. See the module comment for the reasoning and for how to
 * re-enable the file shape safely.
 */
function assertCredentialSource(source: unknown): void {
  if (source === undefined || source === null) return

  const what = isRecord(source)
    ? source.executable !== undefined
      ? "runs an executable"
      : source.url !== undefined
        ? "fetches a URL"
        : source.environment_id !== undefined
          ? "reads cloud VM metadata"
          : source.file !== undefined
            ? "reads a local file"
            : "sources a subject token"
    : "sources a subject token"

  throw new Error(
    `This credentials document ${what} to obtain its subject token (credential_source), which ` +
      `Runbooks does not accept. Sign in with Google, use a service account key, or run ` +
      `\`gcloud auth application-default login\`.`,
  )
}

/**
 * Reject any federated credentials document that could steer google-auth-library
 * somewhere it should not go. Non-federated documents are left alone: they carry
 * no instructions, only fields the layer reads by name.
 *
 * Throws an `Error` whose message is safe to surface — it never quotes the
 * document's secret material, only field names and hostnames.
 */
export function assertFederatedCredentialAllowed(document: unknown): void {
  assertDocumentAllowed(document, "", 0, false)
}

/**
 * @param chained true when this node was reached through `source_credentials`.
 *   A chained node is validated whatever its `type` says, because the library
 *   INHERITS from it. `Impersonated` takes `universeDomain` from its source
 *   client when the parent sets none and derives
 *   `https://iamcredentials.${universeDomain}` from it — the endpoint it then
 *   POSTs `:generateAccessToken` to, carrying the victim's live access token as
 *   a Bearer. So a nested `authorized_user` (not a federated type, and formerly
 *   returned on at the check below) could redirect the whole impersonation
 *   chain to an attacker's host while the parent document looked spotless.
 */
function assertDocumentAllowed(
  document: unknown,
  prefix: string,
  depth: number,
  chained: boolean,
): void {
  if (depth > MAX_DEPTH) {
    throw new Error("The credentials document chains too many source credentials to validate")
  }
  if (!isRecord(document)) return

  const type = typeof document.type === "string" ? document.type : undefined
  if (!chained && (!type || !FEDERATED_TYPES.has(type))) return

  const universeDomain = document.universe_domain
  if (universeDomain !== undefined) {
    if (typeof universeDomain !== "string" || universeDomain.toLowerCase() !== GOOGLE_API_DOMAIN) {
      throw new Error(
        `The credentials document sets universe_domain to something other than "${GOOGLE_API_DOMAIN}", ` +
          `which redirects every token request away from Google.`,
      )
    }
  }

  if ("credential_source" in document) {
    assertCredentialSource(document.credential_source)
  }

  // `source_credentials` is swept by its own recursive call below, which reports
  // failures under a `source_credentials.` field prefix rather than the parent's.
  for (const [key, value] of Object.entries(document)) {
    if (key === "source_credentials") continue
    assertNoForeignUrls(value, prefix ? `${prefix}.${key}` : key, depth)
  }

  if ("source_credentials" in document) {
    const source = document.source_credentials
    if (!isRecord(source)) {
      throw new Error("The credentials document's source_credentials is not a JSON object")
    }
    const sourceType = typeof source.type === "string" ? source.type : undefined
    if (!sourceType || !CHAINABLE_SOURCE_TYPES.has(sourceType)) {
      throw new Error(
        `The credentials document's source_credentials has an unsupported type: ${sourceType ?? "(missing)"}`,
      )
    }
    const nested = prefix ? `${prefix}.source_credentials` : "source_credentials"
    // chained: true — validate it whatever its type claims. The library inherits
    // universe_domain (and therefore the iamcredentials endpoint) from this node.
    assertDocumentAllowed(source, nested, depth + 1, true)
  }
}
