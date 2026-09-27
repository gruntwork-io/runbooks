/**
 * Path validation helpers for IPC handlers.
 *
 * Ensures renderer-supplied paths stay within the session working directory
 * or a registered worktree path.
 */
import path from "path"
import { Effect } from "effect"
import { sessionManager, runbookConfig } from "./runtime.ts"
import { isContainedInReal } from "../../../src/path-validation.ts"
import { PathTraversalError } from "../../../src/errors/index.ts"

/**
 * Resolve a path that may be relative to the runbook directory.
 * If the path is already absolute, it is returned as-is.
 */
function resolveAgainstRunbook(p: string): string {
  if (path.isAbsolute(p)) return p
  const runbookDir = runbookConfig.localPath ? path.dirname(runbookConfig.localPath) : null
  if (runbookDir) return path.resolve(runbookDir, p)
  return path.resolve(p)
}

/**
 * Validate that a path is within the session working directory, a registered
 * worktree, or the runbook directory. Relative paths are resolved against the
 * runbook directory. Returns the resolved absolute path.
 */
export const validateSessionPath = (p: string) =>
  Effect.gen(function* () {
    if (!p) {
      return yield* Effect.fail(new PathTraversalError({ path: p, message: "path must not be empty" }))
    }

    const resolved = resolveAgainstRunbook(p)
    const session = yield* sessionManager.getSession()

    // Allow registered worktree paths
    if (session.registeredWorkTreePaths.includes(resolved)) {
      return resolved
    }

    // Allow paths contained within a registered worktree. Containment is
    // checked against the symlink-resolved (realpath) form of both paths so a
    // symlink planted inside the root can't dereference to an arbitrary file.
    for (const wt of session.registeredWorkTreePaths) {
      if (yield* Effect.promise(() => isContainedInReal(resolved, wt))) {
        return resolved
      }
    }

    // Allow paths contained within the session working directory
    if (yield* Effect.promise(() => isContainedInReal(resolved, session.workingDir))) {
      return resolved
    }

    // Allow paths contained within the runbook directory
    const runbookDir = runbookConfig.localPath ? path.dirname(runbookConfig.localPath) : null
    if (runbookDir && (yield* Effect.promise(() => isContainedInReal(resolved, runbookDir)))) {
      return resolved
    }

    return yield* Effect.fail(
      new PathTraversalError({
        path: p,
        message: `path is outside session working directory and registered worktrees`,
      }),
    )
  })

/**
 * Validate a git:clone destination. The clone handler may `rm -rf` it (from
 * "Delete & Clone"), so this is stricter than validateSessionPath. The
 * destination must be:
 *   - inside the working directory once symlinks are resolved, so a
 *     symlinked segment (`link/sub`, where link points outside) can't aim
 *     the rm outside the session;
 *   - a strict subdirectory: ".", "./", "sub/.." and the working directory's
 *     own absolute path would otherwise delete the working directory itself;
 *   - not an ancestor of the open runbook. A Command block's `cd ..` moves the
 *     working directory (the script's final pwd is stored as the session
 *     working dir), and then the runbook's own directory passes both checks.
 */
export const validateCloneDestination = (
  absolutePath: string,
  workingDir: string,
  runbookPath: string,
) =>
  Effect.gen(function* () {
    const reject = (message: string) =>
      Effect.fail(new PathTraversalError({ path: absolutePath, message }))

    if (!(yield* Effect.promise(() => isContainedInReal(absolutePath, workingDir)))) {
      return yield* reject("clone destination is outside session working directory")
    }
    // Contained both ways means it is the working directory itself.
    if (yield* Effect.promise(() => isContainedInReal(workingDir, absolutePath))) {
      return yield* reject("clone destination must be a subdirectory of the session working directory")
    }
    if (runbookPath && (yield* Effect.promise(() => isContainedInReal(runbookPath, absolutePath)))) {
      return yield* reject("clone destination must not contain the open runbook")
    }
  })

/**
 * Map a runbook-asset:// request URL to the file it names in the runbook
 * directory, or null if it must not be served. The URL's host + path
 * (runbook-asset://assets/foo.png -> assets/foo.png) is percent-decoded
 * before the check, so the path that is checked is the path that is served.
 * Containment is checked on the symlink-resolved path, so a symlink in the
 * runbook directory (assets/k.png -> ~/.ssh/id_ed25519) can't serve a file
 * from outside it.
 */
export async function resolveRunbookAssetPath(
  requestUrl: string,
  runbookDir: string,
): Promise<string | null> {
  let assetRelative: string
  try {
    const url = new URL(requestUrl)
    assetRelative = decodeURIComponent(url.hostname + url.pathname)
  } catch {
    return null
  }
  const resolved = path.resolve(path.join(runbookDir, assetRelative))
  return (await isContainedInReal(resolved, runbookDir)) ? resolved : null
}
