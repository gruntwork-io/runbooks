/**
 * IPC handlers for runbook operations.
 *
 * Provides runbook file reading, executable registry access, and asset serving.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import * as fs from "fs"
import * as path from "path"
import {
  runtime,
  runbookConfig,
  executableRegistry,
  sessionManager,
  setExecutableRegistry,
  setRunbookConfig,
  cliWorkingDir,
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
        disableLiveFileReload: runbookConfig.disableLiveFileReload,
      }
      setRunbookConfig(config)

      // Ensure a session exists, rooted at the runbook's parent directory.
      // Sessions are created lazily on first runbook load so the working dir
      // is always meaningful for scripts (not a placeholder). --working-dir
      // on the CLI overrides the runbook dir so E2E tests can isolate
      // generated files in a temp dir. realpath'ing keeps macOS /var and
      // /private/var paths aligned with the rest of the pipeline.
      let sessionDir = cliWorkingDir ?? path.dirname(runbookPath)
      try {
        sessionDir = fs.realpathSync(sessionDir)
      } catch {
        // Path may not exist yet — fall back to the lexical resolution.
      }
      if (!sessionManager.hasSession()) {
        await runtime.runPromise(sessionManager.createSession(sessionDir))
      } else if (!cliWorkingDir) {
        sessionManager.setWorkingDir(sessionDir)
      }

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
