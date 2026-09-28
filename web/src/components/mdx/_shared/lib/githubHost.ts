/**
 * GitHub host helpers for the renderer.
 *
 * Mirrors the host functions of the backend's `src/domain/git/github-host.ts`
 * that the UI needs (the renderer cannot import `src/` at runtime). GitHub
 * comes in three shapes:
 *
 *   - github.com
 *   - GitHub Enterprise Cloud with data residency (`<sub>.ghe.com`)
 *   - GitHub Enterprise Server (GHES, any hostname)
 *
 * `tryNormalizeGitHubHost` is STRICT: it never falls back to github.com, so a
 * typo in an enterprise host can't silently retarget a credential. Main parses
 * every host it receives the same way and refuses an unparseable one.
 */

/** The default GitHub host when no enterprise host is specified. */
export const DEFAULT_GITHUB_HOST = 'github.com'

/** `<sub>.ghe.com` — GitHub Enterprise Cloud with data residency. */
const GHE_CLOUD_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/

/** `api.<sub>.ghe.com` — the API origin of a ghe.com tenant. */
const GHE_CLOUD_API_HOST = /^api\.([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com)$/

export type GitHubHostKind = 'dotcom' | 'ghe-cloud' | 'ghes'

/** A lowercase DNS hostname with an optional port. */
const DNS_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/

/**
 * Normalize a GitHub host or URL to a bare, lowercased host (including any
 * non-default port). API origins map back to their web host
 * (`api.github.com` → `github.com`, `api.acme.ghe.com` → `acme.ghe.com`).
 * Returns undefined for empty or unparseable input, a non-http(s) scheme, or
 * embedded credentials — never github.com.
 */
export function tryNormalizeGitHubHost(input?: string | null): string | undefined {
  const raw = (input ?? '').trim()
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
    if (host === 'api.github.com') return DEFAULT_GITHUB_HOST
    const gheApi = GHE_CLOUD_API_HOST.exec(host)
    return gheApi ? gheApi[1] : host
  } catch {
    return undefined
  }
}

/** Like tryNormalizeGitHubHost, but falls back to github.com. Display only. */
export function normalizeGitHubHost(input?: string | null): string {
  return tryNormalizeGitHubHost(input) ?? DEFAULT_GITHUB_HOST
}

/** Classify a normalized host. Anything that isn't github.com or `*.ghe.com` is GHES. */
export function githubHostKind(host: string): GitHubHostKind {
  const h = host.toLowerCase()
  if (h === DEFAULT_GITHUB_HOST) return 'dotcom'
  if (GHE_CLOUD_HOST.test(h)) return 'ghe-cloud'
  return 'ghes'
}

/** Whether `host` is anything other than github.com (GHES or ghe.com). */
export const isGitHubEnterpriseHost = (host: string): boolean => githubHostKind(host) !== 'dotcom'

/** The web origin of a normalized host: `https://<host>`. */
export const githubWebBase = (host: string): string => `https://${host}`

/**
 * Where to create a new personal access token. github.com and ghe.com offer
 * fine-grained tokens; GHES links to the classic token page, which every
 * supported GHES version has.
 */
export function githubTokenCreateUrl(host: string): string {
  return githubHostKind(host) === 'ghes'
    ? `${githubWebBase(host)}/settings/tokens/new`
    : `${githubWebBase(host)}/settings/personal-access-tokens/new`
}

/** The page listing the user's tokens (the fine-grained list; classic on GHES). */
export function githubTokenSettingsUrl(host: string): string {
  return githubHostKind(host) === 'ghes'
    ? `${githubWebBase(host)}/settings/tokens`
    : `${githubWebBase(host)}/settings/personal-access-tokens`
}

/**
 * Whether a repo URL's host is recognizably GitHub by NAME alone: github.com
 * or a `*.ghe.com` tenant. A GHES host has an arbitrary name, so it never
 * matches here — callers learn about it from the linked auth block instead.
 */
export function isGitHubRepoHost(host: string | undefined): boolean {
  if (!host) return false
  return githubHostKind(host) !== 'ghes'
}

/**
 * Resolve the `oauthClientId` block prop for the host being authenticated.
 *
 *   - a string applies to the block's authored `host` when one is set, else
 *     to github.com only (never to a picked enterprise host);
 *   - a map is keyed by host (keys normalized like any host);
 *   - undefined for github.com means "main's default Gruntwork app".
 *
 * Returns undefined when no client ID applies — which, for an enterprise
 * host, means OAuth is unavailable there (main has no default for it).
 */
export function resolveGitHubOAuthClientId(
  oauthClientId: string | Record<string, string> | undefined,
  authoredHost: string | undefined,
  activeHost: string,
): string | undefined {
  if (!oauthClientId) return undefined
  const active = tryNormalizeGitHubHost(activeHost) ?? activeHost
  if (typeof oauthClientId === 'string') {
    const target = authoredHost ? tryNormalizeGitHubHost(authoredHost) : DEFAULT_GITHUB_HOST
    return target === active ? oauthClientId || undefined : undefined
  }
  for (const [key, value] of Object.entries(oauthClientId)) {
    if (value && tryNormalizeGitHubHost(key) === active) return value
  }
  return undefined
}

/** Why the OAuth tab is disabled for an enterprise host without a client ID. */
export function githubOAuthUnavailableReason(host: string): string {
  return `Sign-in with GitHub isn't set up for ${host}. Use a personal access token or 'gh auth login --hostname ${host}' instead.`
}
