/**
 * Path validation helpers for IPC handlers.
 *
 * Ensures renderer-supplied paths stay within the session working directory
 * or a registered worktree path.
 */
import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { sessionManager, runbookConfig } from "./runtime.ts"
import type { RunbookConfig } from "../../../src/types.ts"
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
      return yield* Effect.fail(
        new PathTraversalError({ path: p, message: "path must not be empty" }),
      )
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
      return yield* reject(
        "clone destination must be a subdirectory of the session working directory",
      )
    }
    if (
      runbookPath &&
      (yield* Effect.promise(() => isContainedInReal(runbookPath, absolutePath)))
    ) {
      return yield* reject("clone destination must not contain the open runbook")
    }
  })

/**
 * The host of the runbook's runbook-asset:// URLs
 * (runbook-asset://<host>/foo.png for assets/foo.png). Each runbook gets its
 * own host, and so its own origin, so a page the Iframe block embeds can't
 * read the storage of another runbook's pages. It is derived from the
 * runbook's identity: the remote URL when opened from one, whose clone lands
 * in a new temp folder on every open, otherwise the path of its file. So a
 * page keeps its storage across opens of the same runbook.
 * Starts with a letter so the URL parser never reads it as an IPv4 address.
 */
export function runbookAssetHost(config: Pick<RunbookConfig, "localPath" | "remoteSourceURL">): string {
  const identity = config.remoteSourceURL ?? config.localPath
  return "r" + createHash("sha256").update(identity).digest("hex").slice(0, 32)
}

/**
 * Map a runbook-asset:// request URL to the file it names in the runbook's
 * assets/ folder, or null if it must not be served. Only the open runbook's
 * host (see runbookAssetHost) is served, and its root is the assets/ folder,
 * so a page's `/app.js` loads assets/app.js. The URL's path
 * (runbook-asset://<host>/foo.png -> assets/foo.png) is percent-decoded
 * before the check, so the path that is checked is the path that is served.
 *
 * Only files under assets/ are served, because a page the Iframe block frames
 * runs scripts that can fetch any runbook-asset:// URL. Containment is checked
 * on the symlink-resolved path, so a symlinked file
 * (assets/k.png -> ~/.ssh/id_ed25519) can't serve a file from outside
 * assets/. Nothing is served when assets/ is itself a symlink, because
 * `assets -> .` would make the whole runbook directory, generated files
 * included, count as assets/.
 */
export async function resolveRunbookAssetPath(
  requestUrl: string,
  runbookDir: string,
  assetHost: string,
): Promise<string | null> {
  let assetRelative: string
  try {
    const url = new URL(requestUrl)
    if (url.hostname !== assetHost) return null
    assetRelative = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const assetsDir = path.join(runbookDir, "assets")
  try {
    if ((await fs.promises.lstat(assetsDir)).isSymbolicLink()) return null
  } catch {
    return null
  }
  const resolved = path.resolve(path.join(assetsDir, assetRelative))
  return (await isContainedInReal(resolved, assetsDir)) ? resolved : null
}

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
