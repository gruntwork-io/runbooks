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
import { runtime } from "./ipc/runtime.ts"
import {
  parseRemoteSource,
  needsRefResolution,
  resolveRef,
  adjustBlobPath,
  getTokenForHost,
} from "../../src/remote-source.ts"
import { resolveRunbookPath } from "../../src/domain/workspace/file.ts"
import { GitClient } from "../../src/services/GitClient.ts"
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
 * Returns true if a git stderr string looks like an authentication failure.
 * Used by classifyCloneError to surface a host-specific token hint.
 */
export function isAuthError(stderr: string): boolean {
  if (!stderr) return false
  const lower = stderr.toLowerCase()
  return (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("could not read password") ||
    lower.includes("403") ||
    lower.includes("401") ||
    lower.includes("invalid credentials") ||
    lower.includes("bad credentials") ||
    lower.includes("permission denied") ||
    lower.includes("terminal prompts disabled")
  )
}

/**
 * Returns a host-specific hint for which env var to set for authentication.
 * Falls back to a generic message for hosts we don't special-case.
 */
export function authHintForHost(host: string): string {
  if (host === "github.com") {
    return "GitHub authentication failed. Your token may be expired or missing the `repo` scope. Try setting GITHUB_TOKEN, or run `gh auth login`."
  }
  if (isGitLabHost(host)) {
    return `GitLab authentication failed for ${host}. Set GITLAB_TOKEN, or run \`glab auth login${host === "gitlab.com" ? "" : ` --hostname ${host}`}\`.`
  }
  return `Authentication failed for ${host}. Set the appropriate access-token environment variable for that host.`
}

export type CloneErrorKind = "auth" | "not-found" | "network" | "unknown"

export interface ClassifiedCloneError {
  readonly kind: CloneErrorKind
  readonly hint: string
}

/**
 * Classify a git clone failure into a coarse kind with a user-facing hint.
 * Inputs are the host (so the hint can name the right env var) and the raw
 * git stderr.
 */
export function classifyCloneError(
  host: string,
  stderr: string,
): ClassifiedCloneError {
  if (isAuthError(stderr)) {
    return { kind: "auth", hint: authHintForHost(host) }
  }
  const lower = (stderr ?? "").toLowerCase()
  if (
    lower.includes("repository not found") ||
    lower.includes("not found") ||
    lower.includes("does not exist")
  ) {
    return {
      kind: "not-found",
      hint: `Could not find the repository on ${host}. Check the URL and your access permissions.`,
    }
  }
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
    hint:
      "Clone failed. See the error output for details. If this looks like an auth issue, set the appropriate access-token env var for your git host.",
  }
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
      const token = yield* getTokenForHost(parsed.host)
      log.info("Token:", token ? "found" : "none")
      const authedCloneURL = token
        ? injectTokenIntoUrl(parsed.cloneURL, token)
        : parsed.cloneURL

      // Resolve ambiguous ref/path for browser-style URLs
      if (needsRefResolution(parsed) && parsed.path) {
        log.info("Resolving ref from:", parsed.path)
        const resolved = yield* resolveRef(
          authedCloneURL,
          parsed.path,
          parsed.isBlobURL,
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

      // Clone with sparse checkout if a subpath is specified
      const git = yield* GitClient
      yield* git.cloneSimple(parsed.cloneURL, dest, {
        ref: parsed.ref,
        token: token ?? undefined,
        sparse: parsed.path,
      })
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
