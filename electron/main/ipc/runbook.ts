/**
 * IPC handlers for runbook operations.
 *
 * Provides runbook file reading, executable registry access, and asset serving.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import * as path from "path"
import {
  runtime,
  runbookConfig,
  executableRegistry,
  sessionManager,
  setExecutableRegistry,
  setRunbookConfig,
} from "./runtime.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { readFileMetadata, resolveRunbookPath, getContentType, isAllowedAssetExtension } from "../../../src/domain/workspace/file.ts"
import { containsPathTraversal, isContainedIn } from "../../../src/path-validation.ts"
import { FileSystem } from "../../../src/services/FileSystem.ts"
import type { RunbookConfig } from "../../../src/types.ts"
import { resolveRemoteRunbook } from "../remote.ts"
import { getMainWindow } from "../window.ts"

export function registerRunbookHandlers(): void {
  ipcMain.handle(
    "runbook:get",
    async (_event, params?: { path?: string; watchMode?: boolean; remoteSource?: string }) => {
      // If no path provided, return current config without loading a runbook
      if (!params?.path) {
        return {
          content: "",
          contentHash: "",
          config: runbookConfig,
          warnings: [],
        }
      }

      // Reject filesystem roots to prevent overly broad trust anchors
      const resolvedInput = path.resolve(params.path)
      if (resolvedInput === path.parse(resolvedInput).root) {
        throw new Error("runbook path must not be a filesystem root")
      }

      // Resolve the path — if it's a directory, look for runbook.mdx inside it
      const runbookPath = await runtime.runPromise(resolveRunbookPath(params.path))
      const config: RunbookConfig = {
        localPath: runbookPath,
        remoteSourceURL: params.remoteSource,
        isWatchMode: params.watchMode ?? false,
        useExecutableRegistry: true,
      }
      setRunbookConfig(config)

      // Update the session's working directory to the runbook's parent dir.
      // The session may have been created with '.' before the runbook path
      // was known.
      const runbookDir = path.dirname(runbookPath)
      sessionManager.setWorkingDir(runbookDir)

      // Read the runbook file content
      const fileData = await runtime.runPromise(readFileMetadata(runbookPath))

      // Build the executable registry from the runbook
      const registry = await runtime.runPromise(
        ExecutableRegistry.create(runbookPath),
      )
      setExecutableRegistry(registry)

      // Notify the renderer that the registry has been rebuilt
      const win = getMainWindow()
      if (win) {
        win.webContents.send("registry:updated")
      }

      const ext = path.extname(runbookPath).replace(/^\./, "")

      return {
        path: runbookPath,
        content: fileData.content,
        contentHash: fileData.contentHash,
        language: ext || "mdx",
        size: fileData.content.length,
        isWatchMode: config.isWatchMode,
        warnings: registry.getWarnings(),
        remoteSource: params.remoteSource,
      }
    },
  )

  ipcMain.handle(
    "runbook:open-remote",
    async (_event, params: { url: string }) => {
      const result = await resolveRemoteRunbook(params.url)
      // Notify the renderer to load the resolved runbook
      const win = getMainWindow()
      if (win) {
        win.webContents.send("file:open-runbook", {
          path: result.localPath,
          remoteSource: result.remoteSource,
        })
      }
      return { path: result.localPath, remoteSource: result.remoteSource }
    },
  )

  ipcMain.handle("runbook:executables", async () => {
    if (!executableRegistry) {
      return { executables: {}, warnings: [] }
    }

    return {
      executables: executableRegistry.getAllExecutables(),
      warnings: executableRegistry.getWarnings(),
    }
  })

  ipcMain.handle(
    "runbook:assets",
    async (_event, params: { runbookPath: string; assetPath: string }) => {
      const runbookDir = path.dirname(params.runbookPath)
      const fullPath = path.join(runbookDir, params.assetPath)

      // Validate path traversal
      if (containsPathTraversal(params.assetPath)) {
        throw new Error("Asset path contains directory traversal")
      }
      if (!isContainedIn(fullPath, runbookDir)) {
        throw new Error("Asset path escapes runbook directory")
      }

      // Validate asset extension
      if (!isAllowedAssetExtension(params.assetPath)) {
        throw new Error(`Asset type not allowed: ${params.assetPath}`)
      }

      const contentType = getContentType(params.assetPath)

      const buffer = await runtime.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem
          return yield* fs.readFileBuffer(fullPath)
        }),
      )

      return {
        data: buffer.toString("base64"),
        contentType,
      }
    },
  )
}
