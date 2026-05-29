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
} from "./runtime.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { readFileMetadata, resolveRunbookPath, getContentType, isAllowedAssetExtension } from "../../../src/domain/workspace/file.ts"
import { containsPathTraversal, isContainedInReal } from "../../../src/path-validation.ts"
import { FileSystem } from "../../../src/services/FileSystem.ts"
import type { RunbookConfig } from "../../../src/types.ts"
import { resolveRemoteRunbook } from "../remote.ts"
import { getMainWindow } from "../window.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("ipc:runbook")

/**
 * Build a clean, user-facing message for a failed runbook resolution.
 *
 * `resolveRunbookPath` fails with an Effect `FiberFailure` whose message leaks
 * internal stack detail — surfacing that verbatim in the renderer is the "ugly
 * error" we're replacing. This returns a short explanation the error screen can
 * show directly while offering a "choose another folder" retry.
 */
function describeRunbookOpenError(inputPath: string): string {
  try {
    if (fs.statSync(inputPath).isDirectory()) {
      return `This folder doesn't contain a runbook.mdx file:\n\n${inputPath}\n\nChoose a folder that contains a runbook.mdx file, or select a runbook file directly.`
    }
  } catch {
    return `This path no longer exists:\n\n${inputPath}`
  }
  return `This runbook couldn't be opened:\n\n${inputPath}`
}

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

      // Resolve the path — if it's a directory, look for runbook.mdx inside it.
      // Translate any resolution failure into a clean, user-facing message so
      // the renderer can show a friendly error (and a retry) instead of a raw
      // Effect FiberFailure dump.
      let runbookPath: string
      try {
        runbookPath = await runtime.runPromise(resolveRunbookPath(params.path))
      } catch (err) {
        log.debug("failed to resolve runbook path", params.path, err)
        throw new Error(describeRunbookOpenError(params.path))
      }
      const config: RunbookConfig = {
        localPath: runbookPath,
        remoteSourceURL: params.remoteSource,
        isWatchMode: params.watchMode ?? false,
        useExecutableRegistry: true,
        disableLiveFileReload: runbookConfig.disableLiveFileReload,
      }
      setRunbookConfig(config)

      // The session's working dir is always the runbook's parent directory.
      // realpath'ing keeps macOS /var and /private/var paths aligned with
      // the rest of the pipeline (containment checks elsewhere realpath too).
      let sessionDir = path.dirname(runbookPath)
      try {
        sessionDir = fs.realpathSync(sessionDir)
      } catch {
        // Path may not exist yet — fall back to the lexical resolution.
      }
      if (!sessionManager.hasSession()) {
        await runtime.runPromise(sessionManager.createSession(sessionDir))
      } else {
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
      // Resolve symlinks before the containment check: the asset read below
      // follows them, so a symlink inside the runbook dir must not dereference
      // to a file outside it.
      if (!(await isContainedInReal(fullPath, runbookDir))) {
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
