/**
 * IPC handlers for workspace operations.
 *
 * Provides file tree listing, directory listing, file reading, change
 * detection, and worktree registration/activation.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager, runbookConfig } from "./runtime.ts"
import {
  getWorkspaceTree,
  getWorkspaceDirs,
  readWorkspaceFile,
  getWorkspaceChanges,
} from "../../../src/domain/workspace/workspace.ts"
import { validateRelativePathIn, isContainedIn } from "../../../src/path-validation.ts"
import { validateSessionPath } from "./path-guard.ts"
import { PathTraversalError } from "../../../src/errors/index.ts"
import path from "path"

/**
 * Resolve a renderer-supplied worktree path and fail if it escapes the session
 * working directory (or the runbook directory). Returns the resolved path.
 */
const resolveValidatedWorktree = (worktreePath: string) =>
  Effect.gen(function* () {
    const resolved = path.resolve(worktreePath)
    const session = yield* sessionManager.getSession()
    const runbookDir = runbookConfig.localPath ? path.dirname(runbookConfig.localPath) : null
    if (
      !isContainedIn(resolved, session.workingDir) &&
      !(runbookDir && isContainedIn(resolved, runbookDir))
    ) {
      return yield* Effect.fail(
        new PathTraversalError({
          path: resolved,
          message: "worktree path is outside session working directory",
        }),
      )
    }
    return resolved
  })

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    "workspace:tree",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          yield* validateSessionPath(params.worktreePath)
          return yield* getWorkspaceTree(params.worktreePath)
        }),
      )
    },
  )

  ipcMain.handle(
    "workspace:dirs",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          yield* validateSessionPath(params.worktreePath)
          return yield* getWorkspaceDirs(params.worktreePath)
        }),
      )
    },
  )

  ipcMain.handle(
    "workspace:file",
    async (
      _event,
      params: { worktreePath: string; filePath: string },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          // Accept either shape: an absolute filePath (the UI's default, since
          // file-tree items carry absolute localPaths), or a relative filePath
          // rooted at worktreePath. In both cases we resolve to an absolute
          // path and validate it against session scope — matches main's
          // `/api/workspace/file?path=<abs>` behavior.
          const absFilePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(params.worktreePath, params.filePath)
          yield* validateSessionPath(absFilePath)
          return yield* readWorkspaceFile("", absFilePath)
        }),
      )
    },
  )

  ipcMain.handle(
    "workspace:changes",
    async (
      _event,
      params: { worktreePath: string; singleFile?: string },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          yield* validateSessionPath(params.worktreePath)
          if (params.singleFile) {
            yield* validateRelativePathIn(params.singleFile, params.worktreePath)
          }
          return yield* getWorkspaceChanges(params.worktreePath, params.singleFile)
        }),
      )
    },
  )

  ipcMain.handle(
    "workspace:register",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const resolved = yield* resolveValidatedWorktree(params.worktreePath)
          sessionManager.registerWorkTreePath(resolved)
          return { ok: true as const }
        }),
      )
    },
  )

  ipcMain.handle(
    "workspace:set-active",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const resolved = yield* resolveValidatedWorktree(params.worktreePath)
          sessionManager.setActiveWorkTreePath(resolved)
          return { ok: true as const }
        }),
      )
    },
  )
}
