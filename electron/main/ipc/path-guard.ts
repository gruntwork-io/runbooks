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
 * Validate that an absolute path is a registered worktree path or is
 * contained within the session working directory.
 */
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
