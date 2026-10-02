/**
 * Remote runbook source parsing.
 *
 * Two families of syntax are accepted.
 *
 * 1. Browser URLs — whatever the GitHub or GitLab address bar shows for a
 *    runbook directory, a runbook file, or a repo:
 *
 *      https://github.com/org/repo/tree/main/runbooks/setup-vpc
 *      https://github.com/org/repo/blob/main/runbooks/setup-vpc/runbook.mdx
 *      https://gitlab.com/group/sub/repo/-/tree/main/runbooks/setup-vpc?ref_type=heads
 *      https://github.com/org/repo
 *
 *    The ref and the path share one string (`main/runbooks/setup-vpc`) and a
 *    ref may itself contain slashes, so the split waits for the remote's ref
 *    list (resolveRef). Query strings and fragments (`?ref_type=heads`,
 *    `?plain=1`, `#L10`) are page state, not part of the source.
 *
 * 2. go-getter / OpenTofu module sources — `//` separates the repository
 *    from the path inside it, `?ref=` names a branch, tag or commit, and
 *    no `?ref=` means the remote's default branch:
 *
 *      github.com/org/repo//runbooks/setup-vpc?ref=v1.0
 *      gitlab.com/group/sub/repo//runbooks/setup-vpc
 *      git::https://git.example.com/org/repo.git//runbooks/setup-vpc?ref=main
 *      git::ssh://git@github.com/org/repo.git//runbooks/setup-vpc
 *      git@github.com:org/repo.git//runbooks/setup-vpc?ref=main
 *      https://github.com/org/repo.git//runbooks/setup-vpc
 *
 *    As in go-getter, `github.com/org/repo/runbooks/setup-vpc` (no `//`) also
 *    works: a GitHub repo is always exactly owner/repo. A GitLab project can
 *    sit under nested groups, so its path needs the `//`.
 *
 * Either way the path may name a runbook directory or a runbook file.
 */
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "./services/ProcessSpawner.ts"
import type { SpawnError } from "./errors/index.ts"
import { GitError, RemoteSourceError } from "./errors/index.ts"
import { gitSpawnEnv, resolveSshCommand } from "./domain/git/env.ts"
import { isGitLabHost } from "./domain/git/gitlab-host.ts"
import { isGitHubHost } from "./domain/git/github-host.ts"
import { redactSecrets } from "./domain/vcs/redact.ts"
import type { ParsedRemoteSource } from "./types.ts"

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Scheme-bearing sources: browser URLs, `git::` sources, ssh:// addresses. */
const SCHEME_PREFIX = /^(git::|https?:\/\/|ssh:\/\/)/i

/**
 * scp-like SSH address: `user@host:path`. The user part is required so a
 * local path is never mistaken for one, and may not start with `-`, which
 * git would read as an option.
 */
const SCP_LIKE = /^([A-Za-z0-9._~][A-Za-z0-9._~-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/

/** go-getter's scheme-less GitHub / GitLab detectors. */
const SHORTHAND = /^(github\.com|gitlab\.com)\/(.*)$/i

/**
 * Whether `input` is a remote runbook source rather than a local path. A
 * true result doesn't promise parseRemoteSource accepts it — it decides
 * which of the two the user meant.
 */
export function isRemoteSource(input: string): boolean {
  const trimmed = input.trim()
  return SCHEME_PREFIX.test(trimmed) || SCP_LIKE.test(trimmed) || SHORTHAND.test(trimmed)
}

/**
 * The URL parser's "special" schemes (file aside): any run of `/` and `\`
 * may follow the colon, and a `\` ends the host as a `/` does, so
 * `https://evil.example\@github.com/…` is a request to evil.example.
 */
const SPECIAL_SCHEME = /^(?:https?|ftp|wss?):/i
const SPECIAL_USERINFO = /^((?:https?|ftp|wss?):[/\\]*)[^/\\]*@/i

/**
 * The userinfo of any other scheme's URL, which has a host only after `//`.
 * After a single `/` there is no host and the source never parses, but a
 * message may still echo it (`no repository in ssh:/git:<password>@…`).
 */
const URL_USERINFO = /^(([a-z][a-z0-9+.-]*):\/\/?)([^/]*)@/i

/**
 * A scheme-less `user:password@` or `user@` before a host. An scp-like
 * address (`git@host:path`) keeps its user, which is part of the address.
 */
const SCHEMELESS_USERINFO = /^(?:[^:/@]+:[^/]*@|[^:/@]+@(?![^/]*:))/

/** A `name=value` query parameter, for the sshkey scrub. */
const QUERY_PARAM = /([?&])([^?&#=]*)=([^&#]*)/g

/**
 * `source` with any credentials in it removed, for logs and display. A URL
 * or a scheme-less `user:password@host` loses its whole userinfo (a token
 * can pose as the username); an ssh:// URL keeps its user and loses only a
 * password. go-getter's `sshkey` parameter, a base64 private key, keeps its
 * name and loses its value (splitGoGetter ignores it).
 *
 * The userinfo runs to the last `@` before the path, as it does for the URL
 * parser that finds the host, so a password holding an `@` goes whole. The
 * parser also ends the host at a `?` or `#`, but a source with one before
 * its path has no repository and never parses, so the userinfo runs past
 * them: a password holding one goes whole too.
 */
export function redactSourceCredentials(source: string): string {
  // The URL parser drops tabs and newlines wherever they are (`ht\ttps://`).
  const trimmed = source.replace(/[\t\n\r]/g, "").trim()
  const prefix = /^git::/i.test(trimmed) ? trimmed.slice(0, "git::".length) : ""
  const address = trimmed.slice(prefix.length)
  const redacted = SPECIAL_SCHEME.test(address)
    ? address.replace(SPECIAL_USERINFO, "$1")
    : address
        .replace(URL_USERINFO, (_match, lead: string, scheme: string, userinfo: string) =>
          scheme.toLowerCase() === "ssh" ? `${lead}${userinfo.split(":")[0]}@` : lead,
        )
        .replace(SCHEMELESS_USERINFO, "")
  return (
    prefix +
    redacted.replace(QUERY_PARAM, (param, separator: string, name: string) =>
      isSshKeyParam(name) ? `${separator}${name}=[REDACTED]` : param,
    )
  )
}

/** Whether a query parameter's name is `sshkey`, decoded as go-getter decodes it. */
function isSshKeyParam(name: string): boolean {
  try {
    return decodeURIComponent(name.replace(/\+/g, " ")).toLowerCase() === "sshkey"
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Browser URL shapes (matched against the URL's pathname)
// ---------------------------------------------------------------------------

/**
 * GitHub tree/blob: /owner/repo/(tree|blob)/<ref>/<path>. The host may be
 * github.com, a GHES host or a ghe.com tenant — the shape (no GitLab `/-/`
 * marker) is what identifies it.
 */
const GITHUB_BROWSER_PATH = /^\/([^/]+)\/([^/]+)\/(?:tree|blob)\/(.+)$/

/**
 * GitLab tree/blob: /group/.../project/-/(tree|blob)/<ref>/<path>. The `/-/`
 * marker is GitLab-specific, so any host qualifies and the owner may be a
 * nested group path.
 */
const GITLAB_BROWSER_PATH = /^\/(.+?)\/-\/(?:tree|blob)\/(.+)$/

// ---------------------------------------------------------------------------
// parseRemoteSource
// ---------------------------------------------------------------------------

export interface ParseRemoteSourceOptions {
  /**
   * Enterprise GitHub hosts the user configured (gh's hosts.yml, GH_HOST). A
   * GHES host has an arbitrary name, so a plain `https://<host>/owner/repo`
   * URL is recognized as GitHub only for these (and github.com / ghe.com).
   */
  readonly githubHosts?: readonly string[]
}

const UNSUPPORTED =
  "unsupported URL format: use a GitHub or GitLab link to a runbook directory or runbook.mdx, " +
  "or a source like github.com/org/repo//path/to/runbook?ref=main"

/** A malformed source; parseRemoteSource turns it into a RemoteSourceError. */
class InvalidSource extends Error {}

/**
 * Parse a remote runbook source (any syntax in the module comment) into the
 * repo to clone, the ref, and the path inside it. Fails with a
 * RemoteSourceError whose message is fit to show the user and whose url is
 * the source without any credentials typed into it.
 */
export const parseRemoteSource = (
  raw: string,
  opts: ParseRemoteSourceOptions = {},
): Effect.Effect<ParsedRemoteSource, RemoteSourceError> =>
  Effect.try({
    try: () => parse(raw.trim(), opts),
    catch: (err) =>
      new RemoteSourceError({
        url: redactSourceCredentials(raw),
        message: err instanceof InvalidSource ? err.message : UNSUPPORTED,
      }),
  })

/** Dispatch a trimmed source to the parser for its syntax; throws InvalidSource. */
function parse(input: string, opts: ParseRemoteSourceOptions): ParsedRemoteSource {
  if (!input) throw new InvalidSource("empty URL")

  // `git::` forces a plain git source, whatever the address looks like.
  if (/^git::/i.test(input)) return parseGitSource(input.slice("git::".length))
  if (/^ssh:\/\//i.test(input) || SCP_LIKE.test(input)) return parseGitSource(input)
  if (/^https?:\/\//i.test(input)) return parseHttpSource(input, opts)
  if (SHORTHAND.test(input)) return parseShorthand(input, opts)
  throw new InvalidSource(UNSUPPORTED)
}

/**
 * `http(s)://` input: a browser URL, a go-getter source over https (a `//`
 * subdirectory or a `.git` repo address), or a plain repo URL.
 */
function parseHttpSource(input: string, opts: ParseRemoteSourceOptions): ParsedRemoteSource {
  const url = parseUrl(input)
  const host = url.host.toLowerCase()

  // Browser tree/blob URLs. A GitLab host's `/g/p/tree/...` is a subgroup
  // path, not a GitHub URL.
  const github = url.pathname.match(GITHUB_BROWSER_PATH)
  if (github && !isGitLabHost(host)) {
    const [, owner, repo, refAndPath] = github
    return browserSource(host, decodePath(`${owner}/${repo}`), refAndPath)
  }
  const gitlab = url.pathname.match(GITLAB_BROWSER_PATH)
  if (gitlab) {
    const [, ownerRepoPath, refAndPath] = gitlab
    return browserSource(host, decodePath(ownerRepoPath), refAndPath)
  }

  const { address, subdir, ref } = splitGoGetter(input)
  if (subdir !== undefined || /\.git\/?$/i.test(parseUrl(address).pathname)) {
    return parseGitSource(input)
  }

  // Plain repo URLs: the repo root, on `?ref=` or the default branch.
  const segments = decodePath(url.pathname).split("/").filter(Boolean)
  if (segments.length === 2 && isGitHubHost(host, opts.githubHosts)) {
    return repoSource(host, segments.join("/"), { ref })
  }
  // GitLab supports nested groups, so the last segment is the project and
  // everything before it the owner. Only hosts recognizably GitLab by name
  // qualify; others (e.g. bitbucket.org) are unsupported.
  if (segments.length >= 2 && isGitLabHost(host)) {
    return repoSource(host, gitLabProjectPath(segments), { ref })
  }
  throw new InvalidSource(UNSUPPORTED)
}

/**
 * A GitLab `group/.../project` path. GitLab reserves the `-` segment for its
 * own pages (no group or project path may start with `-`), so a path holding
 * one is a page such as `/-/raw/…` or `/-/commits/…`, never nested groups.
 */
function gitLabProjectPath(segments: readonly string[]): string {
  if (segments.includes("-")) throw new InvalidSource(UNSUPPORTED)
  return segments.join("/")
}

/**
 * go-getter's scheme-less `github.com/…` and `gitlab.com/…` sources. A
 * browser URL pasted without its `https://` is taken as the browser URL.
 */
function parseShorthand(input: string, opts: ParseRemoteSourceOptions): ParsedRemoteSource {
  const { address, subdir, ref } = splitGoGetter(input)
  if (subdir === undefined && ref === undefined) {
    const url = parseUrl(`https://${input}`)
    if (GITHUB_BROWSER_PATH.test(url.pathname) || GITLAB_BROWSER_PATH.test(url.pathname)) {
      return parseHttpSource(`https://${input}`, opts)
    }
  }

  const [hostPart, ...rest] = address.split("/")
  const host = hostPart.toLowerCase()
  const segments = rest.filter(Boolean)
  if (segments.length < 2) {
    throw new InvalidSource(
      `expected ${host}/<owner>/<repo>, got ${redactSourceCredentials(input)}`,
    )
  }
  if (host === "github.com") {
    // go-getter's GitHub detector: segments past owner/repo are the path.
    const extra = segments.slice(2).join("/")
    const path = [extra, subdir].filter(Boolean).join("/")
    return repoSource(host, segments.slice(0, 2).join("/"), {
      ref,
      path: path || undefined,
    })
  }
  return repoSource(host, gitLabProjectPath(segments), { ref, path: subdir })
}

/**
 * A plain git source (what follows `git::`): `<address>[//<path>][?ref=…]`,
 * where the address is an http(s) URL, an ssh:// URL, or scp-like
 * `user@host:path`. The address is cloned as given (no `.git` is added:
 * not every git server accepts one).
 */
function parseGitSource(source: string): ParsedRemoteSource {
  const { address, subdir, ref } = splitGoGetter(source)

  const scp = address.match(SCP_LIKE)
  let host: string
  let repoPath: string
  let cloneURL: string
  if (scp) {
    host = scp[2].toLowerCase()
    repoPath = scp[3]
    cloneURL = address
  } else {
    const url = parseUrl(address)
    const protocol = url.protocol.toLowerCase()
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
      // Named only when spelled as one (`file://…`): in `user:password@host`
      // the "scheme" is the user, which may be a token.
      throw new InvalidSource(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(address)
          ? `unsupported git transport "${url.protocol}" (use https, http or ssh)`
          : UNSUPPORTED,
      )
    }
    host = url.host.toLowerCase()
    repoPath = url.pathname
    // Credentials never ride in the source: tokens come from the host's
    // configured credentials, and SSH authenticates with keys. An ssh://
    // URL keeps its user (`git@`), which is part of the address.
    const user = protocol === "ssh:" && url.username ? `${url.username}@` : ""
    cloneURL = `${protocol}//${user}${host}${url.pathname.replace(/\/+$/, "")}`
  }

  const { owner, repo } = splitOwnerRepo(decodePath(repoPath))
  if (!repo || !host) throw new InvalidSource(`no repository in ${redactSourceCredentials(source)}`)
  return { host, owner, repo, cloneURL, ref, path: normalizeRepoPath(subdir) }
}

// ---------------------------------------------------------------------------
// Builders and helpers
// ---------------------------------------------------------------------------

/** A GitHub/GitLab repo cloned over HTTPS. */
function repoSource(
  host: string,
  ownerRepoPath: string,
  extra: { ref?: string; path?: string } = {},
): ParsedRemoteSource {
  const { owner, repo } = splitOwnerRepo(ownerRepoPath)
  return {
    host,
    owner,
    repo,
    // An http:// browser URL still clones over https.
    cloneURL: `https://${host}/${owner}/${repo}.git`,
    ref: extra.ref,
    path: normalizeRepoPath(extra.path),
  }
}

/** A browser URL's repo, with its `<ref>/<path>` left joined for resolveRef. */
function browserSource(
  host: string,
  ownerRepoPath: string,
  rawRefAndPath: string,
): ParsedRemoteSource {
  const source = repoSource(host, ownerRepoPath)
  // A ref can't contain `..` either (git check-ref-format), so the whole
  // string gets the path rules.
  const refAndPath = normalizeRepoPath(decodePath(rawRefAndPath))
  return refAndPath ? { ...source, refAndPath } : source
}

/**
 * Split a go-getter source into its address, the `//` subdirectory, and the
 * `?ref=` query parameter — go-getter's SourceDirSubdir. The `://` of a
 * scheme is skipped so it never reads as the separator. Other query
 * parameters (`depth`, `sshkey`) don't apply here and are ignored (an echo
 * of the source goes through redactSourceCredentials, which scrubs the
 * sshkey), and a `#fragment` is page state, not part of the source.
 *
 * A `+` in the query stays a `+`: URLSearchParams (like go-getter) reads it
 * as a space, which no git ref can contain, while a tag can hold one (semver
 * build metadata, `v1.0.0+build.1`). `%2B` still decodes to `+`.
 */
function splitGoGetter(raw: string): { address: string; subdir?: string; ref?: string } {
  const hashStart = raw.indexOf("#")
  const source = hashStart === -1 ? raw : raw.slice(0, hashStart)
  const queryStart = source.indexOf("?")
  const beforeQuery = queryStart === -1 ? source : source.slice(0, queryStart)
  const query = new URLSearchParams(
    queryStart === -1 ? "" : source.slice(queryStart + 1).replace(/\+/g, "%2B"),
  )
  const ref = query.get("ref") || undefined

  const schemeEnd = beforeQuery.indexOf("://")
  const separator = beforeQuery.indexOf("//", schemeEnd === -1 ? 0 : schemeEnd + 3)
  if (separator === -1) return { address: beforeQuery, ref }
  return {
    address: beforeQuery.slice(0, separator),
    subdir: beforeQuery.slice(separator + 2),
    ref,
  }
}

/**
 * Split a slash-delimited `owner/.../repo` path into its owner and repo parts.
 * The last segment is the repo (project, with any `.git` suffix stripped) and
 * everything before it is the owner. For GitLab nested groups the owner is the
 * full group path, e.g. `group/subgroup/project` → owner "group/subgroup",
 * repo "project".
 */
function splitOwnerRepo(ownerRepoPath: string): { owner: string; repo: string } {
  const segments = ownerRepoPath.split("/").filter(Boolean)
  const repo = (segments[segments.length - 1] ?? "").replace(/\.git$/i, "")
  const owner = segments.slice(0, -1).join("/")
  return { owner, repo }
}

/**
 * A repo-relative path without empty or `.` segments; undefined for the
 * repo root. `..` and backslashes are rejected: the path is joined onto the
 * clone directory and must stay inside it.
 */
function normalizeRepoPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".")
  for (const segment of segments) {
    if (segment === ".." || segment.includes("\\") || segment.includes("\0")) {
      throw new InvalidSource(`invalid path "${raw}": it must stay inside the repository`)
    }
  }
  return segments.length > 0 ? segments.join("/") : undefined
}

/** Percent-decode a URL path (browser URLs encode spaces and the like). */
function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** `new URL`, throwing InvalidSource (the unsupported-format message) on failure. */
function parseUrl(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new InvalidSource(UNSUPPORTED)
  }
}

// ---------------------------------------------------------------------------
// resolveRef
// ---------------------------------------------------------------------------

/**
 * Uses `git ls-remote` to determine the correct ref from a combined ref/path string.
 * Tries longest match first so that a ref like "feature/foo" beats "feature".
 *
 * `env` overrides the spawn environment (defaults to `gitSpawnEnv()`), e.g. to
 * authenticate a private repo with withGitHttpAuth.
 *
 * A failed ls-remote (auth, network, missing repo) fails with a GitError
 * carrying git's redacted stderr rather than guessing a ref, so the caller
 * can classify it as it does a failed clone.
 */
export const resolveRef = (
  cloneURL: string,
  rawRefAndPath: string,
  env?: Record<string, string | undefined>,
): Effect.Effect<
  { ref: string; path: string | undefined },
  GitError | SpawnError,
  ProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner

    // Fetch all remote refs. gitSpawnEnv keeps ssh non-interactive so an
    // ls-remote against an unknown SSH host fails fast instead of hanging on
    // the host-key prompt, while still running the user's core.sshCommand.
    // A caller-supplied env must be built the same way (see electron/main/remote.ts).
    // `--` so a URL starting with `-` can never read as an option.
    const proc = yield* spawner.spawn("git", ["ls-remote", "--refs", "--", cloneURL], {
      env: env ?? gitSpawnEnv(yield* resolveSshCommand()),
    })
    const lines: string[] = []
    const stderr: string[] = []
    yield* Stream.runForEach(proc.output, (line) => {
      if (line.source === "stderr") {
        stderr.push(line.line)
      } else if (line.line.trim()) {
        lines.push(line.line)
      }
      return Effect.void
    })
    const code = yield* proc.exitCode
    if (code !== 0) {
      return yield* Effect.fail(
        new GitError({
          command: "git ls-remote",
          stderr: redactSecrets(stderr.join("\n")),
          exitCode: code,
        }),
      )
    }

    // Build set of known ref names (strip refs/heads/ and refs/tags/)
    const knownRefs = new Set<string>()
    for (const line of lines) {
      const parts = line.split("\t")
      if (parts.length >= 2) {
        const refName = parts[1]
          .trim()
          .replace(/^refs\/heads\//, "")
          .replace(/^refs\/tags\//, "")
        knownRefs.add(refName)
      }
    }

    // Split rawRefAndPath into segments and try longest ref match first
    const segments = rawRefAndPath.split("/")
    for (let i = segments.length; i >= 1; i--) {
      const candidateRef = segments.slice(0, i).join("/")
      if (knownRefs.has(candidateRef)) {
        const remainingPath = segments.slice(i).join("/") || undefined
        return { ref: candidateRef, path: remainingPath }
      }
    }

    // Fall back: assume first segment is the ref (a commit SHA from a
    // permalink lands here — ls-remote lists only branches and tags).
    const ref = segments[0]
    const path = segments.slice(1).join("/") || undefined
    return { ref, path }
  })
