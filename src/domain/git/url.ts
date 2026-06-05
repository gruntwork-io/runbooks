/**
 * Git URL helpers shared by the GitClient layer, the Electron IPC clone
 * handler, and the remote-source resolver.
 */

/**
 * Inject an OAuth/access token into an HTTPS git URL as `<username>:<token>@host`.
 *
 * - `username` defaults to `x-access-token`, which GitHub accepts for token
 *   auth. GitLab expects the username `oauth2` with a personal access token as
 *   the password, so callers cloning gitlab.com pass `oauth2`.
 * - Returns the URL unchanged if it cannot be parsed (e.g. SSH form
 *   `git@host:owner/repo`, empty string, malformed input).
 * - Replaces any existing userinfo rather than appending — a URL like
 *   `https://old:old@host/repo.git` becomes `https://<username>:<token>@host/repo.git`,
 *   never `https://old:old@<username>:<token>@host/repo.git`.
 */
export function injectTokenIntoUrl(
  url: string,
  token: string,
  username = "x-access-token",
): string {
  try {
    const parsed = new URL(url)
    parsed.username = username
    parsed.password = token
    return parsed.toString()
  } catch {
    return url
  }
}
