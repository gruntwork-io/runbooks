/**
 * GitHub host helpers.
 *
 * GitHub comes in three shapes, each with its own API origin:
 *
 *   - github.com                       → https://api.github.com
 *   - GitHub Enterprise Cloud with data
 *     residency (`<sub>.ghe.com`)      → https://api.<sub>.ghe.com
 *   - GitHub Enterprise Server (GHES,
 *     any hostname)                    → https://<host>/api/v3
 *
 * The OAuth device flow always lives on the web origin
 * (`https://<host>/login/device/code`, `/login/oauth/access_token`).
 *
 * Mirrors gitlab-host.ts: a lenient normalizer that falls back to github.com
 * for display, and a STRICT one (`tryNormalizeGitHubHost`) that never does.
 * Anything that sends a token must use the strict parse: silently rebinding a
 * GHES host's token to github.com on a typo would transmit it cross-origin.
 *
 * GitHub is always reached over https. An `http://` instance URL is accepted
 * as input but only its host is kept, so a token is never sent in plaintext.
 */

/** The default GitHub host when no enterprise host is specified. */
export const DEFAULT_GITHUB_HOST = "github.com"

/** `<sub>.ghe.com` — GitHub Enterprise Cloud with data residency. */
const GHE_CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/

/** `api.<sub>.ghe.com` — the API origin of a ghe.com tenant. */
const GHE_CLOUD_API_HOST = /^api\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com)$/

export type GitHubHostKind = "dotcom" | "ghe-cloud" | "ghes"

/** A lowercase DNS hostname with an optional port. */
const DNS_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/

/**
 * Normalize a user-supplied GitHub host or URL (`ghes.example.com`,
 * `https://ghes.example.com/org/repo`, `https://api.github.com`) to a bare,
 * lowercased host (including any non-default port). An API origin maps back
 * to its web host (`api.github.com` → `github.com`,
 * `api.acme.ghe.com` → `acme.ghe.com`); GHES serves its API under `/api/v3`
 * on the web host, so that case needs no mapping. Returns undefined for empty
 * or unparseable input, a non-http(s) scheme, or embedded credentials — never
 * github.com.
 */
export function tryNormalizeGitHubHost(input?: string | null): string | undefined {
  const raw = (input ?? "").trim()
  if (!raw) return undefined
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (hasScheme && !/^https?:\/\//i.test(raw)) return undefined
  try {
    const u = new URL(hasScheme ? raw : `https://${raw}`)
    if (u.username || u.password) return undefined
    const host = u.host.toLowerCase()
    // DNS labels (+ optional port) only: the URL parser admits characters
    // such as `;` `,` `'` `*` in a host, which must never reach an API URL,
    // a gh argument or the CSP.
    if (!DNS_HOST.test(host)) return undefined
    if (host === "api.github.com") return DEFAULT_GITHUB_HOST
    const gheApi = GHE_CLOUD_API_HOST.exec(host)
    return gheApi ? gheApi[1] : host
  } catch {
    return undefined
  }
}

/**
 * Like tryNormalizeGitHubHost, but falls back to github.com. For display and
 * picker keys only — never for choosing where a token goes.
 */
export function normalizeGitHubHost(input?: string | null): string {
  return tryNormalizeGitHubHost(input) ?? DEFAULT_GITHUB_HOST
}

export const isGitHubDotCom = (host: string): boolean => host.toLowerCase() === DEFAULT_GITHUB_HOST

/** Whether `host` is a GitHub Enterprise Cloud data-residency tenant (`<sub>.ghe.com`). */
export const isGheCloudHost = (host: string): boolean => GHE_CLOUD_HOST.test(host.toLowerCase())

/** Classify a normalized host. Anything that isn't github.com or `*.ghe.com` is GHES. */
export function githubHostKind(host: string): GitHubHostKind {
  if (isGitHubDotCom(host)) return "dotcom"
  if (isGheCloudHost(host)) return "ghe-cloud"
  return "ghes"
}

/** Whether `host` is anything other than github.com (GHES or ghe.com). */
export const isGitHubEnterpriseHost = (host: string): boolean => !isGitHubDotCom(host)

/** The web origin of a normalized host: `https://<host>`. */
export const githubWebBase = (host: string): string => `https://${host}`

/** The REST API base of a normalized host (see the module comment). */
export function githubApiBase(host: string): string {
  switch (githubHostKind(host)) {
    case "dotcom":
      return "https://api.github.com"
    case "ghe-cloud":
      return `https://api.${host}`
    case "ghes":
      return `https://${host}/api/v3`
  }
}

/** OAuth device-flow endpoints, on the web origin for every host kind. */
export const githubDeviceCodeUrl = (host: string): string => `${githubWebBase(host)}/login/device/code`
export const githubAccessTokenUrl = (host: string): string =>
  `${githubWebBase(host)}/login/oauth/access_token`

/**
 * Provider detection: whether `host` is GitHub. github.com and `*.ghe.com`
 * are recognized by name; a GHES host has an arbitrary name, so it counts
 * only when the user configured or authenticated it as GitHub (`knownHosts`:
 * gh's hosts.yml, GH_HOST, the session's GitHub host). Never a name heuristic
 * beyond that — a host we can't place is "unknown", not GitLab and not GitHub.
 */
export function isGitHubHost(host: string, knownHosts: Iterable<string> = []): boolean {
  const normalized = tryNormalizeGitHubHost(host)
  if (!normalized) return false
  if (githubHostKind(normalized) !== "ghes") return true
  for (const known of knownHosts) {
    if (tryNormalizeGitHubHost(known) === normalized) return true
  }
  return false
}
