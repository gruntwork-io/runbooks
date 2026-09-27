/**
 * Git URL and credential helpers shared by the GitClient layer, the Electron
 * IPC clone handler, and the remote-source resolver.
 */

/** True for the URL schemes git talks to over HTTP, where a token can apply. */
const isHttpUrl = (parsed: URL): boolean =>
  parsed.protocol === "https:" || parsed.protocol === "http:"

/**
 * The HTTP basic-auth username to send alongside a provider token.
 *
 * GitHub accepts `x-access-token` for every token type. GitLab ignores the
 * username for personal access tokens, but GitLab 16.x and older only accept
 * an OAuth token (e.g. from a glab OAuth login) as the password when the
 * username is `oauth2`, which is also the username GitLab documents. Keyed by
 * provider, never by host, so a self-managed GitLab on an arbitrary hostname
 * still gets `oauth2`.
 */
export const gitCredentialUsername = (provider?: "github" | "gitlab"): string =>
  provider === "gitlab" ? "oauth2" : "x-access-token"

/**
 * Remove `user:password@` userinfo from an http(s) URL, so a remote URL that
 * carries a token (e.g. a checkout someone cloned with one embedded) is safe
 * to display or send to the renderer.
 *
 * Anything else comes back unchanged: SSH URLs (`ssh://git@host/...`, where
 * the user is part of the address rather than a secret), the scp form
 * (`git@host:owner/repo`), and anything `new URL` cannot parse. A URL with no
 * userinfo is also returned as given rather than re-serialized.
 */
export function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    if (!isHttpUrl(parsed) || (!parsed.username && !parsed.password)) return url
    parsed.username = ""
    parsed.password = ""
    return parsed.toString()
  } catch {
    return url
  }
}

/**
 * Authenticate one git invocation's HTTP(S) requests to `url` with `token`,
 * without putting the token in the URL.
 *
 * A token embedded in the clone URL is saved verbatim as `remote.origin.url`
 * in the checkout's `.git/config`, and it shows up in `ps` for the life of the
 * process. Instead, this returns `env` plus git configuration passed through
 * the environment (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` /
 * `GIT_CONFIG_VALUE_<n>`, git 2.31+), which lasts only as long as the command
 * and is never written to disk:
 *
 *  - `credential.helper` is reset to an empty list. Otherwise a rejected token
 *    makes git fall back to the user's credential helper and then tell it to
 *    erase what it returned, deleting the user's own saved login.
 *  - `http.<origin>/.extraHeader` is reset, then set to a basic-auth
 *    `Authorization` header built from `username` and `token`. The reset drops
 *    any stale header for the same host from the user's config (e.g. one a CI
 *    checkout persisted), so exactly one `Authorization` header is sent.
 *
 * The entries are appended after any `GIT_CONFIG_COUNT` entries already in
 * `env`. `env` is returned unchanged when there is no token, or when `url` is
 * not http(s): SSH and scp-form remotes authenticate with SSH keys, and a
 * token has no place there.
 */
export function withGitHttpAuth(
  env: Record<string, string | undefined>,
  url: string,
  token: string | undefined,
  username = "x-access-token",
): Record<string, string | undefined> {
  if (!token) return env
  let origin: string
  try {
    const parsed = new URL(url)
    if (!isHttpUrl(parsed)) return env
    origin = parsed.origin
  } catch {
    return env
  }

  // btoa only takes Latin-1, so encode to UTF-8 bytes first.
  const basic = btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${token}`)))
  const entries: Array<[string, string]> = [
    ["credential.helper", ""],
    [`http.${origin}/.extraHeader`, ""],
    [`http.${origin}/.extraHeader`, `Authorization: Basic ${basic}`],
  ]

  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10)
  const offset = Number.isInteger(existing) && existing > 0 ? existing : 0
  const next: Record<string, string | undefined> = {
    ...env,
    GIT_CONFIG_COUNT: String(offset + entries.length),
  }
  entries.forEach(([key, value], i) => {
    next[`GIT_CONFIG_KEY_${offset + i}`] = key
    next[`GIT_CONFIG_VALUE_${offset + i}`] = value
  })
  return next
}
