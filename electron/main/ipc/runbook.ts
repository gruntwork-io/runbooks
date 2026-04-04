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
  setExecutableRegistry,
  setRunbookConfig,
} from "./runtime.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { readFileMetadata, getContentType, isAllowedAssetExtension } from "../../../src/domain/workspace/file.ts"
import { FileSystem } from "../../../src/services/FileSystem.ts"
import type { RunbookConfig } from "../../../src/types.ts"

export function registerRunbookHandlers(): void {
  ipcMain.handle(
    "runbook:get",
    async (_event, params: { path: string; watchMode?: boolean }) => {
      const runbookPath = params.path
      const config: RunbookConfig = {
        localPath: runbookPath,
        isWatchMode: params.watchMode ?? false,
        useExecutableRegistry: true,
      }
      setRunbookConfig(config)

      // Read the runbook file content
      const fileData = await runtime.runPromise(readFileMetadata(runbookPath))

      // Build the executable registry from the runbook
      const registry = await runtime.runPromise(
        ExecutableRegistry.create(runbookPath),
      )
      setExecutableRegistry(registry)

      return {
        content: fileData.content,
        contentHash: fileData.contentHash,
        config,
        warnings: registry.getWarnings(),
      }
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
