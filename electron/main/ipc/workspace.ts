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
import path from "path"

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    "workspace:tree",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const worktreePath = yield* validateSessionPath(params.worktreePath)
          return yield* getWorkspaceTree(worktreePath)
        }),
      )
    },
  )

  ipcMain.handle(
    "workspace:dirs",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          const worktreePath = yield* validateSessionPath(params.worktreePath)
          return yield* getWorkspaceDirs(worktreePath)
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
          const resolvedFilePath = yield* validateSessionPath(absFilePath)
          return yield* readWorkspaceFile("", resolvedFilePath)
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
          const worktreePath = yield* validateSessionPath(params.worktreePath)
          if (params.singleFile) {
            yield* validateRelativePathIn(params.singleFile, worktreePath)
          }
          return yield* getWorkspaceChanges(worktreePath, params.singleFile)
        }),
      )
    },
  )

  ipcMain.handle(
    "workspace:register",
    async (_event, params: { worktreePath: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          // Registered worktrees pass wherever they live (git:local-repo
          // registers the local checkout picked in a <GitClone> block). Any
          // other path must resolve into the session with symlinks followed,
          // so a symlink planted there can't register a root outside it.
          const resolved = yield* validateSessionPath(params.worktreePath)
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
          const resolved = yield* validateSessionPath(params.worktreePath)
          sessionManager.setActiveWorkTreePath(resolved)
          return { ok: true as const }
        }),
      )
    },
  )
}
