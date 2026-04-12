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
          yield* validateSessionPath(params.worktreePath)
          yield* validateRelativePathIn(params.filePath, params.worktreePath)
          return yield* readWorkspaceFile(params.worktreePath, params.filePath)
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
          const resolved = path.resolve(params.worktreePath)
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
          const resolved = path.resolve(params.worktreePath)
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
          sessionManager.setActiveWorkTreePath(resolved)
          return { ok: true as const }
        }),
      )
    },
  )
}
