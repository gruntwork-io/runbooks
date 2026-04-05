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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function injectTokenIntoUrl(url: string, token: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = "x-access-token"
    parsed.password = token
    return parsed.toString()
  } catch {
    return url
  }
}

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
// Temp directory tracking
// ---------------------------------------------------------------------------

const tempCloneDirs = new Set<string>()

/**
 * Remove all temp clone directories. Called on app quit.
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
      console.log("[remote] Parsing URL:", rawUrl)
      let parsed = yield* parseRemoteSource(rawUrl)
      console.log("[remote] Parsed:", { host: parsed.host, owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, path: parsed.path })

      // Get auth token early — needed for both resolveRef (git ls-remote)
      // and the clone itself.
      console.log("[remote] Getting auth token...")
      const token = yield* getTokenForHost(parsed.host)
      console.log("[remote] Token:", token ? "found" : "none")
      const authedCloneURL = token
        ? injectTokenIntoUrl(parsed.cloneURL, token)
        : parsed.cloneURL

      // Resolve ambiguous ref/path for browser-style URLs
      if (needsRefResolution(parsed) && parsed.path) {
        console.log("[remote] Resolving ref from:", parsed.path)
        const resolved = yield* resolveRef(
          authedCloneURL,
          parsed.path,
          parsed.isBlobURL,
        )
        parsed = { ...parsed, ref: resolved.ref, path: resolved.path }
        console.log("[remote] Resolved ref:", resolved.ref, "path:", resolved.path)
      }

      // Convert blob URLs to parent directory
      if (parsed.isBlobURL) {
        parsed = adjustBlobPath(parsed)
      }

      // Create temp directory
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-remote-"))
      tempCloneDirs.add(tempDir)

      const dest = path.join(tempDir, "repo")
      console.log("[remote] Cloning to:", dest, "ref:", parsed.ref, "sparse:", parsed.path)

      // Clone with sparse checkout if a subpath is specified
      const git = yield* GitClient
      yield* git.cloneSimple(parsed.cloneURL, dest, {
        ref: parsed.ref,
        token: token ?? undefined,
        sparse: parsed.path,
      })
      console.log("[remote] Clone complete")

      // Resolve the runbook file within the clone
      const runbookDir = parsed.path ? path.join(dest, parsed.path) : dest
      console.log("[remote] Resolving runbook in:", runbookDir)
      const localPath = yield* resolveRunbookPath(runbookDir)
      console.log("[remote] Resolved runbook path:", localPath)

      return {
        localPath,
        remoteSource: rawUrl,
      } satisfies RemoteRunbookResult
    }),
  )
}
