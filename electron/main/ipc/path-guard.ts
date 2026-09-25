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
import {
  DEFAULT_GENERATED_DIR,
  resolveToAbsolutePath,
} from "../../../src/domain/files/generated.ts"

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
 * Resolve the generated-files directory. Template renders, `$GENERATED_FILES`
 * capture, and the existing-files check and Delete action all go through
 * here so they agree on one directory.
 *
 * A relative `outputPath` resolves against the session's `initialWorkDir` (the
 * realpath'd runbook directory), never the live `workingDir`: that follows a
 * script's `cd`, which would scatter output across whatever directories the
 * runbook's scripts happened to leave the session in.
 *
 * Returns the base directory and relative path alongside the absolute path so
 * callers of `checkGeneratedFiles` / `deleteGeneratedFiles` can pass the same
 * pair and report paths consistent with this one.
 */
export const resolveGeneratedDir = (outputPath: string = DEFAULT_GENERATED_DIR) =>
  Effect.gen(function* () {
    const session = yield* sessionManager.getSession()
    const baseDir = session.initialWorkDir
    const absolutePath = yield* resolveToAbsolutePath(baseDir, outputPath)
    return { baseDir, outputPath, absolutePath }
  })
