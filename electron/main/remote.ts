/**
 * Remote URL resolution for the Electron app.
 *
 * Detects remote URLs, clones them to temp directories, and resolves
 * the local runbook path within the clone.
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Effect } from "effect"
import { runtime, getSessionTokenForHost } from "./ipc/runtime.ts"
import {
  parseRemoteSource,
  needsRefResolution,
  resolveRef,
  adjustBlobPath,
} from "../../src/remote-source.ts"
import { resolveRunbookPath } from "../../src/domain/workspace/file.ts"
import { GitClient } from "../../src/services/GitClient.ts"
import { VcsCredentials } from "../../src/services/VcsCredentials.ts"
import { RemoteSourceError } from "../../src/errors/index.ts"
import { injectTokenIntoUrl } from "../../src/domain/git/url.ts"
import { isGitLabHost } from "../../src/domain/git/gitlab-host.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("remote")

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

const REMOTE_PREFIXES = ["http://", "https://", "git::"]
const REMOTE_SHORTHAND = /^(github\.com|gitlab\.com)\//

/**
 * Returns true if the input looks like a remote URL rather than a local path.
 */
export function isRemoteURL(input: string): boolean {
  const trimmed = input.trim()
  if (REMOTE_PREFIXES.some((p) => trimmed.startsWith(p))) return true
  if (REMOTE_SHORTHAND.test(trimmed)) return true
  return false
}

// ---------------------------------------------------------------------------
// Error classification — give users actionable hints when a clone fails.
// ---------------------------------------------------------------------------

/**
 * An HTTP 401/403 as git reports it: "The requested URL returned error: 403",
 * "error: RPC failed; HTTP 401 curl 22 ...". A bare "401"/"403" also matches
 * --progress counters ("Receiving objects: 89% (403/452)"), the temp clone
 * path and repo names.
 */
const HTTP_AUTH_STATUS = /(?:returned error:\s*|\bhttp\s+)40[13]\b/

/**
 * Returns true if a git stderr string looks like an authentication failure.
 * Golang-parity semantics (beta-v0.9.0 cmd/remote_open.go isAuthError —
 * note that an HTTP 404 / "repository not found" IS an auth signal: private
 * repos present as 404 to unauthenticated clients), plus a few extra
 * patterns git emits on this side.
 *
 * Deliberate divergence: golang matched a bare "403" anywhere. The stderr
 * scanned here includes the `--progress` counters and the
 * `Cloning into '<tmp path>'` line, so 401/403 must appear as an HTTP status,
 * and "permission denied" only in SSH's `Permission denied (<methods>)` form —
 * a filesystem error ends in `: Permission denied`.
 */
export function isAuthError(stderr: string): boolean {
  if (!stderr) return false
  const lower = stderr.toLowerCase()
  return (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("could not read password") ||
    lower.includes("http 404") ||
    lower.includes("repository not found") ||
    lower.includes("fatal: could not read") ||
    HTTP_AUTH_STATUS.test(lower) ||
    lower.includes("invalid credentials") ||
    lower.includes("bad credentials") ||
    lower.includes("permission denied (") ||
    lower.includes("terminal prompts disabled")
  )
}

/**
 * Host-specific auth hints — golang parity (beta-v0.9.0 api.AuthHintForHost):
 * the env-var remedy and the CLI login command for a host, or undefined for
 * hosts we don't special-case. Hostname matching is case-insensitive.
 *
 * For a self-hosted GitLab host the env remedy names BOTH halves: per the
 * binding, GITLAB_TOKEN alone is only ever released to GITLAB_HOST's
 * instance (default gitlab.com), so "set GITLAB_TOKEN" without the binding
 * would advise a no-op.
 */
export function authHintForHost(
  host: string,
): { envRemedy: string; cliCmd: string } | undefined {
  const lower = host.toLowerCase()
  if (lower === "github.com") {
    return { envRemedy: "GITHUB_TOKEN", cliCmd: "gh auth login" }
  }
  if (isGitLabHost(lower)) {
    return lower === "gitlab.com"
      ? { envRemedy: "GITLAB_TOKEN", cliCmd: "glab auth login" }
      : {
          envRemedy: `GITLAB_TOKEN and GITLAB_HOST=${lower}`,
          cliCmd: `glab auth login --hostname ${lower}`,
        }
  }
  return undefined
}

export type CloneErrorKind = "auth" | "network" | "unknown"

export interface ClassifiedCloneError {
  readonly kind: CloneErrorKind
  readonly hint: string
}

/**
 * Classify a git clone failure into a user-facing message. The auth-case
 * strings are golang contracts (beta-v0.9.0 cmd/remote_open.go
 * classifyCloneError, pinned by the ported tests):
 *   no token:   authentication required for <host>/<owner>/<repo>: set <VAR>, or run '<cmd>'
 *   with token: authentication failed for <repo> (token may be invalid or
 *               expired): verify <VAR>, or re-run '<cmd>'
 */
export function classifyCloneError(opts: {
  host: string
  owner: string
  repo: string
  stderr: string
  hadToken: boolean
}): ClassifiedCloneError {
  const { host, owner, repo, stderr, hadToken } = opts
  if (isAuthError(stderr)) {
    const repoPath = `${host}/${owner}/${repo}`
    const hints = authHintForHost(host)
    if (!hadToken) {
      return {
        kind: "auth",
        hint: hints
          ? `authentication required for ${repoPath}: set ${hints.envRemedy}, or run '${hints.cliCmd}'`
          : `authentication required for ${repoPath}: provide an access token for ${host}`,
      }
    }
    return {
      kind: "auth",
      hint: hints
        ? `authentication failed for ${repoPath} (token may be invalid or expired): verify ${hints.envRemedy}, or re-run '${hints.cliCmd}'`
        : `authentication failed for ${repoPath} (token may be invalid or expired)`,
    }
  }
  const lower = (stderr ?? "").toLowerCase()
  if (
    lower.includes("could not resolve host") ||
    lower.includes("connection refused") ||
    lower.includes("connection timed out") ||
    lower.includes("connect to host") ||
    lower.includes("network is unreachable")
  ) {
    return {
      kind: "network",
      hint: `Could not reach ${host}. Check your internet connection.`,
    }
  }
  return {
    kind: "unknown",
    hint: `failed to download runbook: ${stderr || "unknown error"}`,
  }
}

/**
 * Map a failed git step of a remote open — the ls-remote that resolves the
 * ref, or the clone — to a RemoteSourceError carrying classifyCloneError's
 * hint, so both give the same auth/network guidance.
 */
export const failWithCloneHint =
  (opts: { url: string; host: string; owner: string; repo: string; hadToken: boolean }) =>
  (err: unknown): Effect.Effect<never, RemoteSourceError> => {
    const stderr =
      typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : String(err)
    const classified = classifyCloneError({
      host: opts.host,
      owner: opts.owner,
      repo: opts.repo,
      stderr,
      hadToken: opts.hadToken,
    })
    return Effect.fail(new RemoteSourceError({ url: opts.url, message: classified.hint }))
  }

// ---------------------------------------------------------------------------
// Temp directory tracking
// ---------------------------------------------------------------------------

const tempCloneDirs = new Set<string>()

/**
 * Register a temp clone directory for later cleanup. Exposed mainly so the
 * tests can exercise cleanupTempClones without triggering a real clone.
 */
export function registerTempCloneDir(dir: string): void {
  tempCloneDirs.add(dir)
}

/**
 * Remove all temp clone directories. Called on app quit. Tolerates
 * already-deleted directories without throwing.
 */
export function cleanupTempClones(): void {
  for (const dir of tempCloneDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
  tempCloneDirs.clear()
}

// ---------------------------------------------------------------------------
// Remote runbook resolution
// ---------------------------------------------------------------------------

export interface RemoteRunbookResult {
  localPath: string
  remoteSource: string
}

/**
 * The token for cloning from `host`: the session env first (a token
 * established by a GitAuth block is reused), then the unified VcsCredentials
 * resolver.
 */
export const selectCloneToken = (
  host: string,
): Effect.Effect<string | undefined, never, VcsCredentials> =>
  Effect.gen(function* () {
    const provider =
      host.toLowerCase() === "github.com"
        ? ("github" as const)
        : isGitLabHost(host)
          ? ("gitlab" as const)
          : undefined
    // Host-bound: the session token is released only to the host the
    // auth block bound it to — `host` is attacker-controlled input,
    // and the provider name-heuristic alone must never gate a credential.
    const sessionToken = provider
      ? yield* getSessionTokenForHost(provider, host, () => new Error("no session token")).pipe(
          Effect.orElseSucceed(() => undefined),
        )
      : undefined
    const vcs = yield* VcsCredentials
    return sessionToken ?? (yield* vcs.tokenForHost(host))
  })

/**
 * Parse a remote URL, clone the repo (with sparse checkout if needed),
 * and resolve the runbook file path within the clone.
 */
export async function resolveRemoteRunbook(
  rawUrl: string,
): Promise<RemoteRunbookResult> {
  return runtime.runPromise(
    Effect.gen(function* () {
      // Parse the URL
      log.info("Parsing URL:", rawUrl)
      let parsed = yield* parseRemoteSource(rawUrl)
      log.info("Parsed:", { host: parsed.host, owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, path: parsed.path })

      // Get auth token early — needed for both resolveRef (git ls-remote)
      // and the clone itself.
      log.info("Getting auth token...")
      const token = yield* selectCloneToken(parsed.host)
      log.info("Token:", token ? "found" : "none")
      const authedCloneURL = token
        ? injectTokenIntoUrl(parsed.cloneURL, token)
        : parsed.cloneURL
      // Failures of either git step get the golang-parity classification
      // (remote-open strings).
      const toRemoteSourceError = failWithCloneHint({
        url: rawUrl,
        host: parsed.host,
        owner: parsed.owner,
        repo: parsed.repo,
        hadToken: token !== undefined,
      })

      // Resolve ambiguous ref/path for browser-style URLs
      if (needsRefResolution(parsed) && parsed.path) {
        log.info("Resolving ref from:", parsed.path)
        const resolved = yield* resolveRef(authedCloneURL, parsed.path).pipe(
          Effect.catchAll(toRemoteSourceError),
        )
        parsed = { ...parsed, ref: resolved.ref, path: resolved.path }
        log.info("Resolved ref:", resolved.ref, "path:", resolved.path)
      }

      // Convert blob URLs to parent directory
      if (parsed.isBlobURL) {
        parsed = adjustBlobPath(parsed)
      }

      // Create temp directory
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-remote-"))
      registerTempCloneDir(tempDir)

      const dest = path.join(tempDir, "repo")
      log.info("Cloning to:", dest, "ref:", parsed.ref, "sparse:", parsed.path)

      // Clone with sparse checkout if a subpath is specified.
      const git = yield* GitClient
      yield* git
        .cloneSimple(parsed.cloneURL, dest, {
          ref: parsed.ref,
          token: token ?? undefined,
          sparse: parsed.path,
        })
        .pipe(Effect.catchAll(toRemoteSourceError))
      log.info("Clone complete")

      // Resolve the runbook file within the clone
      const runbookDir = parsed.path ? path.join(dest, parsed.path) : dest
      log.info("Resolving runbook in:", runbookDir)
      const localPath = yield* resolveRunbookPath(runbookDir)
      log.info("Resolved runbook path:", localPath)

      return {
        localPath,
        remoteSource: rawUrl,
      } satisfies RemoteRunbookResult
    }),
  )
}
