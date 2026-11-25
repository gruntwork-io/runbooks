import { parseGitRemoteUrl } from "@/lib/gitRemoteUrl"

/** URL schemes git runs over SSH. scp-like remotes (`git@host:path`) are SSH too. */
const SSH_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git"])

/** A path segment the HTTPS rewrite will copy as is; anything else gets no rewrite. */
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/

/** Hostname of a `host[:port]` string, lowercased, or undefined when it does not parse. */
function hostnameOf(host: string): string | undefined {
  try {
    return new URL(`https://${host}/`).hostname
  } catch {
    return undefined
  }
}

export interface SshRemoteForSignIn {
  /**
   * The same repository over HTTPS on the sign-in's host, or undefined when
   * the path is not a plain `group/.../project` path that maps across.
   */
  httpsUrl?: string | undefined
}

/**
 * Describes `url` when it is an SSH or scp-like remote on the same host as a
 * sign-in (`signInHost`, `host[:port]`), else undefined. The clone sends the
 * sign-in's token only to an HTTPS URL on that host, so a remote on another
 * host would not use the sign-in over HTTPS either.
 *
 * The HTTPS URL uses `signInHost` as given, port included: an SSH port is not
 * the web port, while the sign-in's host is where the instance serves HTTPS.
 */
export function sshRemoteForSignIn(
  url: string,
  signInHost: string,
): SshRemoteForSignIn | undefined {
  const remote = parseGitRemoteUrl(url.trim())
  if (!remote || !(remote.scpLike || SSH_SCHEMES.has(remote.scheme))) return undefined
  if (!remote.hostname || remote.hostname !== hostnameOf(signInHost)) return undefined

  // An scp-like path that starts with `/` or `~` names a directory on the
  // server, which has no HTTPS counterpart.
  const path = remote.scpLike ? remote.path : remote.path.replace(/^\//, "")
  const segments = path.split("/")
  const mapsToHttps =
    segments.length >= 2 && segments.every((s) => SAFE_SEGMENT.test(s) && s !== "." && s !== "..")
  return { httpsUrl: mapsToHttps ? `https://${signInHost}/${segments.join("/")}` : undefined }
}

/** Messages ssh and git print when SSH authentication fails. */
const SSH_AUTH_ERRORS = [
  /permission denied \(publickey/i,
  /no such identity/i,
  /host key verification failed/i,
  /too many authentication failures/i,
  /load key .*: (invalid format|bad permissions)/i,
  /sign_and_send_pubkey/i,
]

/** True when `message` reports an SSH authentication failure. */
export function isSshAuthError(message: string): boolean {
  return SSH_AUTH_ERRORS.some((pattern) => pattern.test(message))
}

/** The note shown when an SSH URL will not use the linked sign-in. */
export function sshSignInNote(provider: "github" | "gitlab"): string {
  const name = provider === "gitlab" ? "GitLab" : "GitHub"
  return `This URL uses your SSH keys, not your ${name} sign-in. Use the HTTPS URL to clone with the sign-in.`
}
