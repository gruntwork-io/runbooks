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
      let parsed = yield* parseRemoteSource(rawUrl)

      // Resolve ambiguous ref/path for browser-style URLs
      if (needsRefResolution(parsed) && parsed.path) {
        const resolved = yield* resolveRef(
          parsed.cloneURL,
          parsed.path,
          parsed.isBlobURL,
        )
        parsed = { ...parsed, ref: resolved.ref, path: resolved.path }
      }

      // Convert blob URLs to parent directory
      if (parsed.isBlobURL) {
        parsed = adjustBlobPath(parsed)
      }

      // Get auth token
      const token = yield* getTokenForHost(parsed.host)

      // Create temp directory
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-remote-"))
      tempCloneDirs.add(tempDir)

      const dest = path.join(tempDir, "repo")

      // Clone with sparse checkout if a subpath is specified
      const git = yield* GitClient
      yield* git.cloneSimple(parsed.cloneURL, dest, {
        ref: parsed.ref,
        token: token ?? undefined,
        sparse: parsed.path,
      })

      // Resolve the runbook file within the clone
      const runbookDir = parsed.path ? path.join(dest, parsed.path) : dest
      const localPath = yield* resolveRunbookPath(runbookDir)

      return {
        localPath,
        remoteSource: rawUrl,
      } satisfies RemoteRunbookResult
    }),
  )
}
