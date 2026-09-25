/**
 * Remote URL parsing.
 *
 * Handles OpenTofu-style git:: URLs, GitHub/GitLab shorthand, and browser URLs.
 */
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "./services/ProcessSpawner.ts"
import type { SpawnError } from "./errors/index.ts"
import { GitError, RemoteSourceError } from "./errors/index.ts"
import { gitSpawnEnv } from "./domain/git/env.ts"
import { redactSecrets } from "./domain/vcs/redact.ts"
import { isGitLabHost } from "./domain/git/gitlab-host.ts"
import type { ParsedRemoteSource } from "./types.ts"

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

/**
 * OpenTofu git:: prefix: git::https://host/owner/.../repo.git//path?ref=v1.0
 * The owner/repo portion (everything between the host and the `//` path
 * delimiter) may be a nested group path on GitLab.
 */
const GIT_PREFIX_REGEX = /^git::/i

/**
 * OpenTofu shorthand: github.com/owner/repo//path?ref=v1.0 (or gitlab.com,
 * where the owner may be a nested group path). Scheme-less, so it is given
 * an https:// scheme before parsing.
 */
const SHORTHAND_REGEX = /^(?:github|gitlab)\.com\//i

/** GitHub browser tree URL: https://github.com/owner/repo/tree/ref/path */
const GITHUB_TREE_REGEX =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)$/

/** GitHub browser blob URL: https://github.com/owner/repo/blob/ref/file */
const GITHUB_BLOB_REGEX =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/

/**
 * GitLab browser tree URL: https://host/group/.../repo/-/tree/ref/path
 * The `/-/` marker is GitLab-specific, so the host may be gitlab.com or a
 * self-hosted instance, and the owner may be a nested group path.
 */
const GITLAB_TREE_REGEX =
  /^https?:\/\/([^/]+)\/(.+?)\/-\/tree\/(.+)$/

/** GitLab browser blob URL: https://host/group/.../repo/-/blob/ref/file */
const GITLAB_BLOB_REGEX =
  /^https?:\/\/([^/]+)\/(.+?)\/-\/blob\/(.+)$/

/**
 * Plain GitHub repo URL: https://github.com/owner/repo (no nested groups).
 * The repo name may contain dots (e.g. `docs.example.io`).
 */
const PLAIN_GITHUB_REPO_REGEX =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/

/**
 * Plain GitLab repo URL: https://<host>/group/.../repo
 * Captures the host so self-hosted instances are supported; the caller only
 * accepts it when the host is recognizably GitLab (isGitLabHost). Supports
 * nested groups — the last path segment is the repo (project) and everything
 * before it is the owner.
 */
const PLAIN_GITLAB_REPO_REGEX =
  /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/

/**
 * Split a slash-delimited `owner/.../repo` path into its owner and repo parts.
 * The last segment is the repo (project, with any `.git` suffix stripped) and
 * everything before it is the owner. For GitLab nested groups the owner is the
 * full group path, e.g. `group/subgroup/project` → owner "group/subgroup",
 * repo "project".
 */
const splitOwnerRepo = (
  ownerRepoPath: string,
): { owner: string; repo: string } => {
  const segments = ownerRepoPath.split("/").filter(Boolean)
  const repo = (segments.pop() ?? "").replace(/\.git$/, "")
  const owner = segments.join("/")
  return { owner, repo }
}

/** Remove leading and trailing slashes. */
const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, "")

// ---------------------------------------------------------------------------
// parseRemoteSource
// ---------------------------------------------------------------------------

export const parseRemoteSource = (raw: string): Effect.Effect<ParsedRemoteSource, RemoteSourceError> =>
  Effect.gen(function* () {
    const trimmed = raw.trim()
    if (!trimmed) {
      return yield* Effect.fail(new RemoteSourceError({ url: raw, message: "empty URL" }))
    }
    const unsupported = new RemoteSourceError({ url: raw, message: "unsupported URL format" })

    // Normalize once, as the golang parser did with url.Parse: strip the
    // OpenTofu `git::` prefix, give the scheme-less shorthand a scheme, then
    // parse. Every form below reads only the lowercased host, the decoded
    // path and (OpenTofu forms) the `ref` query parameter, so a ?query or
    // #fragment never leaks into the repo, ref or path.
    const isGitPrefixed = GIT_PREFIX_REGEX.test(trimmed)
    const isShorthand = !isGitPrefixed && SHORTHAND_REGEX.test(trimmed)
    const input = isGitPrefixed
      ? trimmed.replace(GIT_PREFIX_REGEX, "")
      : isShorthand
        ? `https://${trimmed}`
        : trimmed
    const url = yield* Effect.try({ try: () => new URL(input), catch: () => unsupported })
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return yield* Effect.fail(unsupported)
    }
    // `host` keeps a non-default port (a self-hosted instance on :8443).
    const host = url.host
    // `new URL` percent-encodes the path (spaces, non-ASCII); decode it back
    // so it names the directory in the repo. decodeURI leaves `%2F` encoded:
    // `new URL` has already resolved `.`/`..` segments, and decoding a slash
    // would let `..%2F..` rebuild one that escapes the clone directory.
    const pathname = yield* Effect.try(() => decodeURI(url.pathname)).pipe(
      Effect.orElseSucceed(() => url.pathname),
    )
    // `new URL` only resolves `/`-delimited dot segments, but decodeURI turns
    // `%5C` into a backslash, which Windows' path.join treats as a separator:
    // `..%5C..%5Cetc` would climb out of the clone there. No repo, ref or
    // path legitimately has a `..` segment, so reject one under either
    // separator (on every platform, so the check is tested everywhere).
    if (pathname.split(/[\\/]/).includes("..")) {
      return yield* Effect.fail(unsupported)
    }

    // 1) OpenTofu forms: git::https://host/owner/.../repo.git//path?ref=v1.0
    //    and the github.com / gitlab.com shorthand. The `//path` subdir is
    //    optional (the runbook is then at the repo root), and only `ref` is
    //    read from the query — OpenTofu sources may carry others (`depth`).
    if (isGitPrefixed || isShorthand) {
      const fullPath = trimSlashes(pathname)
      const sep = fullPath.indexOf("//")
      const repoPath = sep >= 0 ? fullPath.slice(0, sep) : fullPath
      const path = sep >= 0 ? trimSlashes(fullPath.slice(sep + 2)) || undefined : undefined
      const { owner, repo } = splitOwnerRepo(repoPath)
      // GitHub has no nested groups → exactly owner/repo. GitLab reserves the
      // `-` segment for its own routes, so a repo path containing one is a
      // browser URL (`gitlab.com/g/p/-/tree/main/x`), not a nested group.
      if (
        !owner ||
        !repo ||
        (host === "github.com" && owner.includes("/")) ||
        repoPath.split("/").includes("-")
      ) {
        return yield* Effect.fail(unsupported)
      }
      return {
        host,
        owner,
        repo,
        ref: url.searchParams.get("ref") || undefined,
        path,
        cloneURL: `https://${host}/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // Browser and plain repo URLs are matched on host + path alone, without
    // a trailing slash.
    const normalized = `https://${host}${pathname.replace(/\/+$/, "")}`

    // 2) GitHub tree URL
    let match = normalized.match(GITHUB_TREE_REGEX)
    if (match) {
      const [, owner, repo, refAndPath] = match
      return {
        host: "github.com",
        owner,
        repo,
        // ref/path split is ambiguous; set path as combined and resolve later
        path: refAndPath,
        refInPath: true,
        cloneURL: `https://github.com/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 3) GitHub blob URL
    match = normalized.match(GITHUB_BLOB_REGEX)
    if (match) {
      const [, owner, repo, refAndPath] = match
      return {
        host: "github.com",
        owner,
        repo,
        path: refAndPath,
        refInPath: true,
        cloneURL: `https://github.com/${owner}/${repo}.git`,
        isBlobURL: true,
      }
    }

    // 4) GitLab tree URL
    match = normalized.match(GITLAB_TREE_REGEX)
    if (match) {
      const [, host, ownerRepoPath, refAndPath] = match
      const { owner, repo } = splitOwnerRepo(ownerRepoPath)
      return {
        host,
        owner,
        repo,
        path: refAndPath,
        refInPath: true,
        cloneURL: `https://${host}/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 5) GitLab blob URL
    match = normalized.match(GITLAB_BLOB_REGEX)
    if (match) {
      const [, host, ownerRepoPath, refAndPath] = match
      const { owner, repo } = splitOwnerRepo(ownerRepoPath)
      return {
        host,
        owner,
        repo,
        path: refAndPath,
        refInPath: true,
        cloneURL: `https://${host}/${owner}/${repo}.git`,
        isBlobURL: true,
      }
    }

    // 6) Plain GitHub repo URL (GitHub has no nested groups → exactly owner/repo)
    match = normalized.match(PLAIN_GITHUB_REPO_REGEX)
    if (match) {
      const [, owner, repo] = match
      return {
        host: "github.com",
        owner,
        repo,
        cloneURL: `https://github.com/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 7) Plain GitLab repo URL (supports nested groups → last segment is the
    //    repo). Accepts gitlab.com and self-hosted GitLab hosts recognizable by
    //    name; other hosts (e.g. bitbucket.org) fall through to "unsupported".
    match = normalized.match(PLAIN_GITLAB_REPO_REGEX)
    if (match) {
      const [, host, ownerRepoPath] = match
      if (isGitLabHost(host)) {
        const { owner, repo } = splitOwnerRepo(ownerRepoPath)
        // A GitLab project always lives under at least one namespace, so a
        // single-segment path (no owner) is not a valid repo URL.
        if (owner) {
          return {
            host,
            owner,
            repo,
            cloneURL: `https://${host}/${owner}/${repo}.git`,
            isBlobURL: false,
          }
        }
      }
    }

    return yield* Effect.fail(unsupported)
  })

// ---------------------------------------------------------------------------
// needsRefResolution
// ---------------------------------------------------------------------------

/**
 * Returns true for browser-style URLs where the ref/path boundary is ambiguous
 * (e.g. `/tree/main/some/path` — is the ref "main" or "main/some"?).
 */
export function needsRefResolution(parsed: ParsedRemoteSource): boolean {
  // Browser URLs store the combined ref+path in `path` without a separate `ref`.
  // An OpenTofu-style URL's `//path` is only ever a path, with or without an
  // explicit `?ref` (no ref means the default branch).
  return parsed.refInPath === true && parsed.ref === undefined && parsed.path !== undefined
}

// ---------------------------------------------------------------------------
// resolveRef
// ---------------------------------------------------------------------------

/**
 * Uses `git ls-remote` to determine the correct ref from a combined ref/path string.
 * Tries longest match first so that a ref like "feature/foo" beats "feature".
 *
 * A failed ls-remote (auth, network, missing repo) fails with a GitError
 * rather than guessing a ref, so the caller can classify it like a failed
 * clone. A segment that matches no ref falls back to being the ref itself,
 * which is how a commit SHA (a permalink) resolves.
 */
export const resolveRef = (
  cloneURL: string,
  rawRefAndPath: string,
): Effect.Effect<
  { ref: string; path: string | undefined },
  GitError | SpawnError,
  ProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner

    // Fetch all remote refs. gitSpawnEnv keeps ssh non-interactive so an
    // ls-remote against an unknown SSH host fails fast instead of hanging on
    // the host-key prompt.
    const proc = yield* spawner.spawn("git", ["ls-remote", "--refs", cloneURL], {
      env: gitSpawnEnv(),
    })
    const lines: string[] = []
    const stderrLines: string[] = []
    yield* Stream.runForEach(proc.output, (line) => {
      if (line.source === "stderr") {
        stderrLines.push(line.line)
      } else if (line.line.trim()) {
        lines.push(line.line)
      }
      return Effect.void
    })
    const code = yield* proc.exitCode
    if (code !== 0) {
      // The URL carries the token, so scrub it from git's output.
      return yield* Effect.fail(
        new GitError({
          command: "git ls-remote",
          stderr: redactSecrets(stderrLines.join("\n")),
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

    // Fall back: assume first segment is the ref
    const ref = segments[0]
    const path = segments.slice(1).join("/") || undefined
    return { ref, path }
  })

// ---------------------------------------------------------------------------
// adjustBlobPath
// ---------------------------------------------------------------------------

/**
 * Converts a blob path to its parent directory so the tool fetches the
 * containing folder rather than a single file.
 */
export function adjustBlobPath(parsed: ParsedRemoteSource): ParsedRemoteSource {
  if (!parsed.isBlobURL || !parsed.path) return parsed
  const lastSlash = parsed.path.lastIndexOf("/")
  const adjustedPath = lastSlash > 0 ? parsed.path.substring(0, lastSlash) : undefined
  return { ...parsed, path: adjustedPath, isBlobURL: false }
}
