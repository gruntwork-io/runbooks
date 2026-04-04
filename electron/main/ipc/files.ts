/**
 * IPC handlers for file operations.
 *
 * Provides file reading and generated file management (check and delete).
 */
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import { readFileMetadata } from "../../../src/domain/workspace/file.ts"
import {
  checkGeneratedFiles,
  deleteGeneratedFiles,
} from "../../../src/domain/files/generated.ts"

export function registerFileHandlers(): void {
  ipcMain.handle(
    "file:read",
    async (_event, params: { path: string }) => {
      return runtime.runPromise(readFileMetadata(params.path))
    },
  )

  ipcMain.handle(
    "generated-files:check",
    async (_event, params: { outputPath: string }) => {
      const workingDir = await getWorkingDir()
      return runtime.runPromise(
        checkGeneratedFiles(workingDir, params.outputPath),
      )
    },
  )

  ipcMain.handle(
    "generated-files:delete",
    async (_event, params: { outputPath: string }) => {
      const workingDir = await getWorkingDir()
      return runtime.runPromise(
        deleteGeneratedFiles(workingDir, params.outputPath),
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
