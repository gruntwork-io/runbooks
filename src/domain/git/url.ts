/**
 * Git URL helpers shared by the GitClient layer, the Electron IPC clone
 * handler, and the remote-source resolver.
 */

/**
 * Inject an OAuth token into an HTTPS git URL as `x-access-token:<token>@host`.
 *
 * - Returns the URL unchanged if it cannot be parsed (e.g. SSH form
 *   `git@host:owner/repo`, empty string, malformed input).
 * - Replaces any existing userinfo rather than appending — a URL like
 *   `https://old:old@host/repo.git` becomes `https://x-access-token:<token>@host/repo.git`,
 *   never `https://old:old@x-access-token:<token>@host/repo.git`.
 */
export function injectTokenIntoUrl(url: string, token: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = "x-access-token"
    parsed.password = token
    return parsed.toString()
  } catch {
    return url
  }
}
