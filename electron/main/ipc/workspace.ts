/**
 * IPC handlers for workspace operations.
 *
 * Provides file tree listing, directory listing, file reading, change
 * detection, and worktree registration/activation.
 */
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import {
  getWorkspaceTree,
  getWorkspaceDirs,
  readWorkspaceFile,
  getWorkspaceChanges,
} from "../../../src/domain/workspace/workspace.ts"

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    "workspace:tree",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(getWorkspaceTree(params.worktreePath))
    },
  )

  ipcMain.handle(
    "workspace:dirs",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(getWorkspaceDirs(params.worktreePath))
    },
  )

  ipcMain.handle(
    "workspace:file",
    async (
      _event,
      params: { worktreePath: string; filePath: string },
    ) => {
      return runtime.runPromise(
        readWorkspaceFile(params.worktreePath, params.filePath),
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
        getWorkspaceChanges(params.worktreePath, params.singleFile),
      )
    },
  )

  ipcMain.handle(
    "workspace:register",
    async (_event, params: { path: string }) => {
      sessionManager.registerWorkTreePath(params.path)
      return { ok: true as const }
    },
  )

  ipcMain.handle(
    "workspace:set-active",
    async (_event, params: { path: string }) => {
      sessionManager.setActiveWorkTreePath(params.path)
      return { ok: true as const }
    },
  )
}
