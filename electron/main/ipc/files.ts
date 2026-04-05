/**
 * IPC handlers for file operations.
 *
 * Provides file reading and generated file management (check and delete).
 */
import * as path from "path"
import { ipcMain } from "electron"
import { runtime, sessionManager, runbookConfig } from "./runtime.ts"
import { readFileMetadata } from "../../../src/domain/workspace/file.ts"
import {
  checkGeneratedFiles,
  deleteGeneratedFiles,
} from "../../../src/domain/files/generated.ts"
import { containsPathTraversal, isContainedIn } from "../../../src/path-validation.ts"

export function registerFileHandlers(): void {
  ipcMain.handle(
    "file:read",
    async (_event, params: { path: string }) => {
      if (containsPathTraversal(params.path)) {
        throw new Error("Path contains directory traversal")
      }
      const workingDir = await getWorkingDir()
      const runbookDir = runbookConfig.localPath ? path.dirname(runbookConfig.localPath) : null
      if (!isContainedIn(params.path, workingDir) &&
          (!runbookDir || !isContainedIn(params.path, runbookDir))) {
        throw new Error("Path outside allowed directories")
      }
      return runtime.runPromise(readFileMetadata(params.path))
    },
  )

  ipcMain.handle(
    "generated-files:check",
    async (_event, params?: { outputPath?: string }) => {
      const workingDir = await getWorkingDir()
      const outputPath = params?.outputPath ?? "generated"
      return runtime.runPromise(
        checkGeneratedFiles(workingDir, outputPath),
      )
    },
  )

  ipcMain.handle(
    "generated-files:delete",
    async (_event, params?: { outputPath?: string }) => {
      const workingDir = await getWorkingDir()
      const outputPath = params?.outputPath ?? "generated"
      return runtime.runPromise(
        deleteGeneratedFiles(workingDir, outputPath),
      )
    },
  )
}

/**
 * Helper to get the current working directory from the session.
 * Falls back to process.cwd() if no session exists.
 */
async function getWorkingDir(): Promise<string> {
  try {
    const metadata = await runtime.runPromise(sessionManager.getMetadata())
    return metadata.workingDir
  } catch {
    return process.cwd()
  }
}
