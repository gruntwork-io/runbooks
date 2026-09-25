/**
 * GitLab host/instance helpers.
 *
 * The GitLab REST API client, token validation, and credential detection all
 * need to target the right GitLab instance — `gitlab.com` for SaaS, or an
 * arbitrary host for a self-hosted instance. These helpers turn a user-supplied
 * instance URL (from the GitAuth block) or a repo's own remote URL into the
 * base URL the API client builds requests against.
 *
 * The auth token is still resolved by PROVIDER (GITLAB_TOKEN), never by host —
 * the host only selects which instance's API/glab-config to talk to.
 */

/** The default GitLab instance when no self-hosted instance is specified. */
export const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com"

/**
 * Normalize a user-supplied GitLab instance URL (or bare host) into a clean
 * origin like `https://gitlab.example.com`. Tolerates a missing scheme
 * (`gitlab.example.com` → `https://gitlab.example.com`), trailing slashes, and
 * stray paths/queries. Falls back to gitlab.com for empty or unparseable input.
 *
 * GitLab installed under a URL sub-path (relative URL root) is out of scope —
 * only the origin is kept.
 */
export function normalizeGitLabBaseUrl(input?: string | null): string {
  return tryNormalizeGitLabBaseUrl(input) ?? DEFAULT_GITLAB_BASE_URL
}

/**
 * Like normalizeGitLabBaseUrl, but returns undefined for empty or unparseable
 * input instead of the gitlab.com fallback. Security-sensitive callers (the
 * env-token host binding) must use THIS one: silently rebinding a
 * corporate host's token to gitlab.com on a typo would transmit the token
 * cross-origin.
 */
export function tryNormalizeGitLabBaseUrl(input?: string | null): string | undefined {
  const raw = (input ?? "").trim()
  if (!raw) return undefined
  // Reject a non-http(s) scheme rather than gluing https:// in front of it
  // (which would turn `ftp://host` into the bogus `https://ftp`).
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
  if (hasScheme && !/^https?:\/\//i.test(raw)) return undefined
  const withScheme = hasScheme ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return undefined
    }
    // Keep protocol + host (including any port); drop path/query/hash so callers
    // can append `/api/v4` etc.
    return `${u.protocol}//${u.host}`
  } catch {
    return undefined
  }
}

/** Host-only variant of tryNormalizeGitLabBaseUrl (includes any port). */
export function tryNormalizeGitLabHost(input?: string | null): string | undefined {
  const base = tryNormalizeGitLabBaseUrl(input)
  return base ? new URL(base).host : undefined
}

/**
 * Normalize a host/URL-ish instance string to a bare host (including any
 * port), falling back to the gitlab.com host. An instance parameter may be a
 * bare host OR a scheme-qualified origin — callers that must preserve a
 * manually-entered `http://` scheme keep working from normalizeGitLabBaseUrl;
 * glab-config reads, dedup keys, and user-facing copy key on the bare host.
 */
export function normalizeGitLabHost(input?: string | null): string {
  return new URL(normalizeGitLabBaseUrl(input)).host
}

/** Build the `/api/v4` REST base from a GitLab origin. */
export function gitlabApiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v4`
}

/**
 * Split an SCP-style SSH remote (`user@host:path`) into its parts, or return
 * undefined when `url` isn't one. Any SSH user is accepted, not just `git`:
 * self-managed GitLab can run its SSH server under another name
 * (`gitlab@gitlab.corp.net:group/project.git`).
 *
 * This is the one SCP grammar every remote parser shares (host lookup,
 * owner/repo, clone URL validation). It is deliberately narrow because a clone
 * URL goes into git's argv: the user can't start with `-` or contain `:`, and
 * the host can't start with `-`, so option-like strings
 * (`--upload-pack=…@h:x`, `-oProxyCommand=…@h:x`) and remote-helper syntax
 * (`ext::…`) never pass as a remote. The renderer's GitClone block keeps a
 * copy of this pattern; keep the two in sync.
 */
export function parseScpRemote(
  url: string,
): { user: string; host: string; path: string } | undefined {
  const m = url.match(/^([A-Za-z0-9_][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/)
  return m ? { user: m[1], host: m[2], path: m[3] } : undefined
}

/**
 * Extract the host (including any port) from a git remote URL in either HTTPS
 * (`https://host/owner/repo.git`) or SSH/SCP (`user@host:owner/repo.git`) form.
 * Returns undefined for input that has no recognizable host.
 */
export function gitHostFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed) return undefined
  const scp = parseScpRemote(trimmed)
  if (scp) return scp.host
  try {
    const host = new URL(trimmed).host
    return host || undefined
  } catch {
    return undefined
  }
}

/**
 * Derive the GitLab API origin for a repo from its own remote URL. Used by
 * operations that act on a cloned repo (merge requests, seeding a default
 * branch), where the instance is whatever the repo actually lives on rather
 * than something the user typed.
 *
 * - An http(s) remote keeps its scheme and port, like tryNormalizeGitLabBaseUrl
 *   (plain-http instances exist).
 * - An SSH remote (`ssh://` or SCP form) or a `git://` one maps to
 *   `https://<hostname>`: its port is the SSH server's (or git daemon's), not
 *   the web server's.
 * - Anything else (no remote, a local path, `file://`) returns undefined, never
 *   gitlab.com: the caller's token belongs to one instance and must not be sent
 *   to another.
 */
export function tryGitlabBaseUrlFromRemoteUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed) return undefined
  const scp = parseScpRemote(trimmed)
  if (scp) return `https://${scp.host}`
  try {
    const u = new URL(trimmed)
    if (!u.hostname) return undefined
    if (u.protocol === "http:" || u.protocol === "https:") return `${u.protocol}//${u.host}`
    if (/^(ssh|git\+ssh|ssh\+git|git):$/.test(u.protocol)) return `https://${u.hostname}`
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Best-effort check for whether a host is a GitLab instance, by name. Matches
 * `gitlab.com` and self-hosted hosts that carry a `gitlab` label
 * (`gitlab.example.com`, `gitlab-ce.corp.net`, `code.gitlab.internal`).
 *
 * This is a heuristic used only where the provider isn't already known (the
 * remote-runbook resolver's `getTokenForHost`). A self-hosted GitLab on an
 * unrelated hostname (e.g. `git.corp.net`) won't be recognized here — those
 * flows authenticate through the GitAuth block, which knows the provider
 * explicitly and doesn't rely on this guess.
 */
export function isGitLabHost(host: string): boolean {
  return /(^|[.-])gitlab([.-]|$)/.test(host.toLowerCase())
}
