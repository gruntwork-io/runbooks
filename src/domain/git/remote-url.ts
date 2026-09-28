/**
 * Git remote URL parsing, shared by the main process, the test CLI and the
 * renderer (which re-exports it from web/src/lib/gitRemoteUrl.ts). The
 * renderer bundles this module directly, so it must stay free of Node and
 * Electron imports.
 *
 * git accepts two spellings of a remote, and so does this parser:
 *
 *  - A URL with a scheme: `https://host[:port]/path`,
 *    `ssh://[user@]host[:port]/path`, `git://…`, `file:///path`. Parsed with
 *    the WHATWG URL parser, so userinfo, ports and bracketed IPv6 literals
 *    (`ssh://git@[::1]:2222/o/r.git`) come out the way `new URL` reports them.
 *  - scp-like: `[user@]host:path`. The host is a plain name, a bracketed IPv6
 *    literal (`git@[::1]:o/r.git`), or git's bracketed `[host:port]`, which
 *    may carry the user inside the brackets: git runs
 *    `[git@gitlab.corp:2222]:o/r.git` as `ssh -p 2222 git@gitlab.corp`. After
 *    a plain host the first `:` always starts the path, so `git@host:2222/o/r`
 *    is the path `2222/o/r` on `host`, never port 2222.
 *
 * Anything that could be misread downstream is rejected rather than guessed
 * at: a leading `-` (git or ssh would take the argument as an option), a
 * `[`, `]` or `@` inside a plain host or user, a user both outside and inside
 * the brackets, whitespace, control characters and backslashes (which the
 * WHATWG parser silently drops or rewrites while git and curl do not),
 * remote-helper addresses such as `ext::…`, and IPv6 zone ids
 * (`git@[fe80::1%eth0]:o/r.git`, `ssh://git@[fe80::1%25eth0]/o/r.git`): ssh
 * takes those, but the WHATWG URL parser has no spelling for one, so such a
 * remote names no host a token or an API request could go to.
 */

/** A remote URL split into the parts callers need. */
export interface GitRemoteUrl {
  /** True for the scp-like `[user@]host:path` form. */
  readonly scpLike: boolean
  /** Lowercase URL scheme without the colon (`https`, `ssh`, …); `ssh` for scp-like remotes. */
  readonly scheme: string
  /** Username from the userinfo, if any. A password is never returned. */
  readonly user?: string
  /**
   * Lowercase hostname. An IPv6 literal keeps its brackets, as
   * `URL.hostname` does. Empty only for a host-less URL such as `file:///srv/repo.git`.
   */
  readonly hostname: string
  /** Port, when one was given (a scheme's default port is dropped, as `URL.port` does). */
  readonly port?: string
  /** `hostname` plus `:port` when there is a port: what `URL.host` returns. */
  readonly host: string
  /**
   * The repository path as written: everything after the `:` for scp-like
   * remotes (`o/r.git`), the pathname for URLs (`/o/r.git`).
   */
  readonly path: string
}

/** Owner (namespace) and repository name of a remote. */
export interface GitRemoteOwnerRepo {
  /** Everything before the last path segment; GitLab subgroups included (`group/sub`). */
  readonly owner: string
  /** The last path segment, without a trailing `.git`. */
  readonly repo: string
}

/** Characters no remote we accept may contain anywhere: whitespace, controls, backslash. */
const UNSAFE_CHAR = /[\s\p{Cc}\\]/u

/** `<scheme>://` — the URL form. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** `<helper>::<address>` — git hands these to a remote helper (e.g. `ext::`), not to ssh. */
const REMOTE_HELPER = /^[a-z][a-z0-9+.-]*::/i

/** A plain host or user name: none of `@ / : [ ]` (whitespace is rejected up front). */
const NAME = "[^@/:\\[\\]]+"

/**
 * `[user@]host:path`, where host is a plain name or anything in brackets, and
 * the brackets may hold the user instead: `[user@host:port]:path`.
 */
const SCP_LIKE = new RegExp(
  `^(?:(${NAME})@)?(?:\\[(?:(${NAME})@)?([^@/\\[\\]]+)\\]|(${NAME})):(.+)$`,
)

/** git's bracketed `host:port` spelling inside an scp-like remote. */
const BRACKETED_HOST_PORT = new RegExp(`^(${NAME}):(\\d{1,5})$`)

const withPort = (hostname: string, port: string | undefined): string =>
  port ? `${hostname}:${port}` : hostname

/** The normalized `[…]` hostname when `literal` is an IPv6 address, else undefined. */
function ipv6Hostname(literal: string): string | undefined {
  if (!literal.includes(":")) return undefined
  try {
    return new URL(`http://[${literal}]/`).hostname
  } catch {
    return undefined
  }
}

function parseScpLike(raw: string): GitRemoteUrl | undefined {
  const match = SCP_LIKE.exec(raw)
  if (!match) return undefined
  const [, outerUser, innerUser, bracketed, plain, path] = match
  // `git@[git@host]:path` hands ssh `git@git@host`: which user is meant?
  if (outerUser !== undefined && innerUser !== undefined) return undefined
  const user = outerUser ?? innerUser
  if (user?.startsWith("-")) return undefined

  let hostname: string
  let port: string | undefined
  if (plain !== undefined) {
    hostname = plain
  } else {
    const ipv6 = ipv6Hostname(bracketed)
    const hostPort = ipv6 ? undefined : BRACKETED_HOST_PORT.exec(bracketed)
    if (ipv6) {
      hostname = ipv6
    } else if (hostPort) {
      if (Number(hostPort[2]) > 65535) return undefined
      hostname = hostPort[1]
      port = hostPort[2]
    } else if (!bracketed.includes(":")) {
      hostname = bracketed
    } else {
      // Neither IPv6 nor host:port, e.g. a zone id (`fe80::1%eth0`), which
      // the URL parser has no spelling for.
      return undefined
    }
  }
  if (hostname.startsWith("-")) return undefined
  hostname = hostname.toLowerCase()

  return {
    scpLike: true,
    scheme: "ssh",
    ...(user ? { user } : {}),
    hostname,
    ...(port ? { port } : {}),
    host: withPort(hostname, port),
    path,
  }
}

function parseUrlForm(raw: string): GitRemoteUrl | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname.startsWith("-") || url.username.startsWith("-")) return undefined
  const port = url.port || undefined
  return {
    scpLike: false,
    scheme: url.protocol.slice(0, -1).toLowerCase(),
    ...(url.username ? { user: url.username } : {}),
    hostname,
    ...(port ? { port } : {}),
    host: withPort(hostname, port),
    path: url.pathname,
  }
}

/**
 * Parse a git remote URL in URL or scp-like form (see the module comment).
 * Returns undefined for anything else, including local paths, remote-helper
 * addresses and every input the module comment lists as rejected.
 */
export function parseGitRemoteUrl(raw: string): GitRemoteUrl | undefined {
  if (!raw || raw.startsWith("-") || UNSAFE_CHAR.test(raw)) return undefined
  if (URL_SCHEME.test(raw)) return parseUrlForm(raw)
  // `C:/repo` is a Windows path, not host `C`.
  if (REMOTE_HELPER.test(raw) || /^[a-z]:\//i.test(raw)) return undefined
  return parseScpLike(raw)
}

/**
 * The host HTTP requests made for a remote go to: the host a token bound to
 * the remote may be sent to, and where its provider's web UI and API live.
 *
 *  - http(s): `URL.host`, port included, exactly as the WHATWG parser reads
 *    it. That is the origin withGitHttpAuth attaches a token to, so a token
 *    binding must compare against this host and no other. It includes URLs
 *    parseGitRemoteUrl turns away, such as one with a backslash or a
 *    non-ASCII space in its path: git still pushes to those, token attached.
 *  - ssh://, scp-like and other remotes: the hostname without the port. That
 *    port belongs to SSH (or the git daemon), never to the web server. It is
 *    returned as the host of `https://<hostname>/` (an IDN name as punycode),
 *    and only when that URL's host is the whole name: `git@ho%st:o/r` names
 *    no web host at all, and `git@a#b:o/r` would send requests to `a`.
 *
 * Undefined when there is no host (a local path, `file:///…`) or the remote
 * doesn't parse. Callers must treat that as "no host", never as a reason to
 * pick a default one such as gitlab.com.
 */
export function gitRemoteWebHost(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol === "https:" || url.protocol === "http:") return url.host || undefined
  } catch {
    // Not a WHATWG URL, e.g. scp-like.
  }
  const hostname = parseGitRemoteUrl(raw)?.hostname
  if (!hostname) return undefined
  try {
    const web = new URL(`https://${hostname}/`)
    return web.href === `https://${web.host}/` ? web.host : undefined
  } catch {
    return undefined
  }
}

/**
 * Owner and repository name of a remote: the last path segment is the repo
 * and everything before it the owner, so GitLab subgroups stay in the owner
 * (`https://gitlab.com/group/sub/project.git` → `group/sub` / `project`).
 * Undefined when the URL doesn't parse or its path has fewer than two segments.
 */
export function gitRemoteOwnerRepo(raw: string): GitRemoteOwnerRepo | undefined {
  const remote = parseGitRemoteUrl(raw)
  if (!remote) return undefined
  const parts = remote.path.split("/").filter(Boolean)
  if (parts.length < 2) return undefined
  return {
    owner: parts.slice(0, -1).join("/"),
    repo: parts[parts.length - 1].replace(/\.git$/, ""),
  }
}
