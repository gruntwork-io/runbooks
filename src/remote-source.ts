/**
 * Remote URL parsing ported from api/remote_source.go + api/remote_token.go.
 *
 * Handles OpenTofu-style git:: URLs, GitHub/GitLab shorthand, and browser URLs.
 */
import { Effect, Stream, pipe } from "effect"
import { ProcessSpawner } from "./services/ProcessSpawner.ts"
import type { SpawnError } from "./errors/index.ts"
import { Environment } from "./services/Environment.ts"
import { RemoteSourceError } from "./errors/index.ts"
import type { ParsedRemoteSource } from "./types.ts"

// ---------------------------------------------------------------------------
// URL patterns
// ---------------------------------------------------------------------------

/** OpenTofu git:: prefix: git::https://host/owner/repo.git//path?ref=v1.0 */
const GIT_PREFIX_REGEX =
  /^git::https?:\/\/([^/]+)\/([^/]+)\/([^/.]+?)(?:\.git)?\/\/(.+?)(?:\?ref=(.+))?$/

/** OpenTofu GitHub shorthand: github.com/owner/repo//path?ref=v1.0 */
const GITHUB_SHORTHAND_REGEX =
  /^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/\/(.+?)(?:\?ref=(.+))?$/

/** GitHub browser tree URL: https://github.com/owner/repo/tree/ref/path */
const GITHUB_TREE_REGEX =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)$/

/** GitHub browser blob URL: https://github.com/owner/repo/blob/ref/file */
const GITHUB_BLOB_REGEX =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/

/** GitLab browser tree URL: https://gitlab.com/owner/repo/-/tree/ref/path */
const GITLAB_TREE_REGEX =
  /^https?:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/tree\/(.+)$/

/** GitLab browser blob URL: https://gitlab.com/owner/repo/-/blob/ref/file */
const GITLAB_BLOB_REGEX =
  /^https?:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/blob\/(.+)$/

/** Plain repo URL: https://github.com/owner/repo or https://gitlab.com/owner/repo */
const PLAIN_REPO_REGEX =
  /^https?:\/\/(github\.com|gitlab\.com)\/([^/]+)\/([^/.]+?)(?:\.git)?$/

// ---------------------------------------------------------------------------
// parseRemoteSource
// ---------------------------------------------------------------------------

export const parseRemoteSource = (raw: string): Effect.Effect<ParsedRemoteSource, RemoteSourceError> =>
  Effect.gen(function* () {
    const trimmed = raw.trim()
    if (!trimmed) {
      return yield* Effect.fail(new RemoteSourceError({ url: raw, message: "empty URL" }))
    }

    // 1) git::https://host/owner/repo.git//path?ref=v1.0
    let match = trimmed.match(GIT_PREFIX_REGEX)
    if (match) {
      const [, host, owner, repo, path, ref] = match
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
      const [, owner, repo, refAndPath] = match
      return {
        host: "gitlab.com",
        owner,
        repo,
        path: refAndPath,
        cloneURL: `https://gitlab.com/${owner}/${repo}.git`,
        isBlobURL: false,
      }
    }

    // 6) GitLab blob URL
    match = trimmed.match(GITLAB_BLOB_REGEX)
    if (match) {
      const [, owner, repo, refAndPath] = match
      return {
        host: "gitlab.com",
        owner,
        repo,
        path: refAndPath,
        cloneURL: `https://gitlab.com/${owner}/${repo}.git`,
        isBlobURL: true,
      }
    }

    // 7) Plain repo URL
    match = trimmed.match(PLAIN_REPO_REGEX)
    if (match) {
      const [, host, owner, repo] = match
      return {
        host,
        owner,
        repo,
        cloneURL: `https://${host}/${owner}/${repo}.git`,
        isBlobURL: false,
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

    // Fetch all remote refs
    const proc = yield* spawner.spawn("git", ["ls-remote", "--refs", cloneURL])
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
 * GitLab: checks GITLAB_TOKEN -> `glab auth token`
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

    if (host === "gitlab.com") {
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
