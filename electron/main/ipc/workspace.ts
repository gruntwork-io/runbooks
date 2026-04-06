/**
 * IPC handlers for workspace operations.
 *
 * Provides file tree listing, directory listing, file reading, change
 * detection, and worktree registration/activation.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import {
  getWorkspaceTree,
  getWorkspaceDirs,
  readWorkspaceFile,
  getWorkspaceChanges,
} from "../../../src/domain/workspace/workspace.ts"
import { validateRelativePathIn } from "../../../src/path-validation.ts"
import { validateSessionPath } from "./path-guard.ts"

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
      sessionManager.registerWorkTreePath(params.worktreePath)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    "workspace:set-active",
    async (_event, params: { worktreePath: string }) => {
      sessionManager.setActiveWorkTreePath(params.worktreePath)
      return { ok: true as const }
    },
  )
}
