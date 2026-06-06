/**
 * Remote URL parsing.
 *
 * Handles OpenTofu-style git:: URLs, GitHub/GitLab shorthand, and browser URLs.
 */
import { Effect, Stream, pipe } from "effect"
import { ProcessSpawner } from "./services/ProcessSpawner.ts"
import type { SpawnError } from "./errors/index.ts"
import { Environment } from "./services/Environment.ts"
import { RemoteSourceError } from "./errors/index.ts"
import { gitSpawnEnv } from "./domain/git/env.ts"
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
const GIT_PREFIX_REGEX =
  /^git::https?:\/\/([^/]+)\/(.+?)\/\/(.+?)(?:\?ref=(.+))?$/

/** OpenTofu GitHub shorthand: github.com/owner/repo//path?ref=v1.0 */
const GITHUB_SHORTHAND_REGEX =
  /^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/\/(.+?)(?:\?ref=(.+))?$/

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

/** Plain GitHub repo URL: https://github.com/owner/repo (no nested groups) */
const PLAIN_GITHUB_REPO_REGEX =
  /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/

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
  const repo = segments[segments.length - 1].replace(/\.git$/, "")
  const owner = segments.slice(0, -1).join("/")
  return { owner, repo }
}

// ---------------------------------------------------------------------------
// parseRemoteSource
// ---------------------------------------------------------------------------

export const parseRemoteSource = (raw: string): Effect.Effect<ParsedRemoteSource, RemoteSourceError> =>
  Effect.gen(function* () {
    const trimmed = raw.trim()
    if (!trimmed) {
      return yield* Effect.fail(new RemoteSourceError({ url: raw, message: "empty URL" }))
    }

    // 1) git::https://host/owner/.../repo.git//path?ref=v1.0
    let match = trimmed.match(GIT_PREFIX_REGEX)
    if (match) {
      const [, host, ownerRepoPath, path, ref] = match
      const { owner, repo } = splitOwnerRepo(ownerRepoPath)
      return {
        host,
        owner,
        repo,
        ref,
        path,
        cloneURL: `https://${host}/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 2) github.com/owner/repo//path?ref=v1.0
    match = trimmed.match(GITHUB_SHORTHAND_REGEX)
    if (match) {
      const [, owner, repo, path, ref] = match
      return {
        host: "github.com",
        owner,
        repo,
        ref,
        path,
        cloneURL: `https://github.com/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 3) GitHub tree URL
    match = trimmed.match(GITHUB_TREE_REGEX)
    if (match) {
      const [, owner, repo, refAndPath] = match
      return {
        host: "github.com",
        owner,
        repo,
        // ref/path split is ambiguous; set path as combined and resolve later
        path: refAndPath,
        cloneURL: `https://github.com/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 4) GitHub blob URL
    match = trimmed.match(GITHUB_BLOB_REGEX)
    if (match) {
      const [, owner, repo, refAndPath] = match
      return {
        host: "github.com",
        owner,
        repo,
        path: refAndPath,
        cloneURL: `https://github.com/${owner}/${repo}.git`,
        isBlobURL: true,
      }
    }

    // 5) GitLab tree URL
    match = trimmed.match(GITLAB_TREE_REGEX)
    if (match) {
      const [, host, ownerRepoPath, refAndPath] = match
      const { owner, repo } = splitOwnerRepo(ownerRepoPath)
      return {
        host,
        owner,
        repo,
        path: refAndPath,
        cloneURL: `https://${host}/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 6) GitLab blob URL
    match = trimmed.match(GITLAB_BLOB_REGEX)
    if (match) {
      const [, host, ownerRepoPath, refAndPath] = match
      const { owner, repo } = splitOwnerRepo(ownerRepoPath)
      return {
        host,
        owner,
        repo,
        path: refAndPath,
        cloneURL: `https://${host}/${owner}/${repo}.git`,
        isBlobURL: true,
      }
    }

    // 7) Plain GitHub repo URL (GitHub has no nested groups → exactly owner/repo)
    match = trimmed.match(PLAIN_GITHUB_REPO_REGEX)
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

    // 8) Plain GitLab repo URL (supports nested groups → last segment is the
    //    repo). Accepts gitlab.com and self-hosted GitLab hosts recognizable by
    //    name; other hosts (e.g. bitbucket.org) fall through to "unsupported".
    match = trimmed.match(PLAIN_GITLAB_REPO_REGEX)
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

    return yield* Effect.fail(
      new RemoteSourceError({ url: raw, message: "unsupported URL format" }),
    )
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
  // OpenTofu-style URLs always have an explicit `ref` query parameter.
  return parsed.ref === undefined && parsed.path !== undefined
}

// ---------------------------------------------------------------------------
// resolveRef
// ---------------------------------------------------------------------------

/**
 * Uses `git ls-remote` to determine the correct ref from a combined ref/path string.
 * Tries longest match first so that a ref like "feature/foo" beats "feature".
 */
export const resolveRef = (
  cloneURL: string,
  rawRefAndPath: string,
  _isBlobURL: boolean,
): Effect.Effect<
  { ref: string; path: string | undefined },
  RemoteSourceError | SpawnError,
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
    yield* Stream.runForEach(proc.output, (line) => {
      if (line.source === "stdout" && line.line.trim()) {
        lines.push(line.line)
      }
      return Effect.void
    })
    yield* proc.exitCode

    // Build set of known ref names (strip refs/heads/ and refs/tags/)
    const knownRefs = new Set<string>()
    for (const line of lines) {
      const parts = line.split("\t")
      if (parts.length >= 2) {
        let refName = parts[1].trim()
        refName = refName
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

// ---------------------------------------------------------------------------
// getTokenForHost
// ---------------------------------------------------------------------------

/**
 * Returns an auth token for the given git host.
 *
 * GitHub: checks GITHUB_TOKEN -> GH_TOKEN -> `gh auth token`
 * GitLab (gitlab.com or a self-hosted host recognizable by name):
 *   checks GITLAB_TOKEN -> `glab auth token`
 */
export const getTokenForHost = (
  host: string,
): Effect.Effect<string | undefined, never, Environment | ProcessSpawner> =>
  Effect.gen(function* () {
    const env = yield* Environment
    const spawner = yield* ProcessSpawner

    if (host === "github.com") {
      const ghToken = (yield* env.get("GITHUB_TOKEN")) ?? (yield* env.get("GH_TOKEN"))
      if (ghToken) return ghToken

      return yield* pipe(
        tryCliToken(spawner, "gh", ["auth", "token"]),
        Effect.orElseSucceed(() => undefined),
      )
    }

    // GITLAB_TOKEN is keyed by provider, so it serves any GitLab host —
    // gitlab.com or a self-hosted instance recognizable by name.
    if (isGitLabHost(host)) {
      const glToken = yield* env.get("GITLAB_TOKEN")
      if (glToken) return glToken

      return yield* pipe(
        tryCliToken(spawner, "glab", ["auth", "token"]),
        Effect.orElseSucceed(() => undefined),
      )
    }

    return undefined
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tryCliToken = (
  spawner: ProcessSpawner["Type"],
  command: string,
  args: string[],
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const proc = yield* Effect.orElseSucceed(spawner.spawn(command, args), () => undefined)
    if (!proc) return undefined

    let token = ""
    yield* Stream.runForEach(proc.output, (line) => {
      if (line.source === "stdout") token += line.line.trim()
      return Effect.void
    })
    const code = yield* proc.exitCode
    return code === 0 && token ? token : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))
