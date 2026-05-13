/**
 * Generated files management.
 *
 * Provides functions to check whether an output directory contains generated
 * files and to delete them. All file-system access goes through the FileSystem
 * service so Node.js APIs are never imported directly.
 */

import { Effect, Stream } from "effect"
import * as path from "node:path"

import { FileSystem } from "../../services/FileSystem.js"
import { PathValidationError } from "../../errors/index.js"
import type {
  GeneratedFilesCheckResponse,
  GeneratedFilesDeleteResponse,
} from "../../types.js"

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a raw output path to an absolute path.
 *
 * - If the path is already absolute it is returned as-is.
 * - Relative paths are resolved against `workingDir`.
 * - On macOS, symlinks in `workingDir` are resolved (e.g. /tmp -> /private/tmp)
 *   so the resulting path is consistent even when the output directory does not
 *   yet exist.
 *
 * Requires the FileSystem service for symlink resolution.
 */
export function resolveToAbsolutePath(workingDir: string, rawPath: string) {
  return Effect.gen(function* () {
    if (rawPath === "") {
      return yield* new PathValidationError({
        path: rawPath,
        message: "path cannot be empty",
      })
    }

    // Already absolute — return as-is
    if (path.isAbsolute(rawPath)) {
      return rawPath
    }

    // Resolve symlinks in the working directory (macOS /tmp -> /private/tmp)
    const fs = yield* FileSystem
    const resolvedDir = yield* Effect.catchAll(
      fs.realpath(workingDir),
      () =>
        new PathValidationError({
          path: workingDir,
          message: `failed to resolve symlinks for working directory "${workingDir}"`,
        }),
    )

    return path.join(resolvedDir, rawPath)
  })
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Recursively count all files (not directories) under `absolutePath`.
 * Requires the FileSystem service.
 */
export function countFilesInDirectory(absolutePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem

    let count = 0
    const entries = yield* Stream.runCollect(fs.walk(absolutePath))
    for (const entry of entries) {
      if (entry.isFile) {
        count++
      }
    }
    return count
  })
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * Check whether the output directory has generated files.
 *
 * Returns a `GeneratedFilesCheckResponse` with the file count and resolved
 * paths.
 */
export function checkGeneratedFiles(workingDir: string, outputPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem

    const absoluteOutputPath = yield* resolveToAbsolutePath(workingDir, outputPath)

    // Check if directory exists
    const exists = yield* fs.exists(absoluteOutputPath)
    if (!exists) {
      return {
        hasFiles: false,
        absoluteOutputPath,
        relativeOutputPath: outputPath,
        fileCount: 0,
      } satisfies GeneratedFilesCheckResponse
    }

    // Verify it is a directory
    const stat = yield* Effect.catchAll(
      fs.stat(absoluteOutputPath),
      () =>
        new PathValidationError({
          path: absoluteOutputPath,
          message: "failed to stat output directory",
        }),
    )

    if (!stat.isDirectory) {
      return yield* new PathValidationError({
        path: absoluteOutputPath,
        message: "path exists but is not a directory",
      })
    }

    const fileCount = yield* countFilesInDirectory(absoluteOutputPath)

    return {
      hasFiles: fileCount > 0,
      absoluteOutputPath,
      relativeOutputPath: outputPath,
      fileCount,
    } satisfies GeneratedFilesCheckResponse
  })
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete all files in the output directory (but preserve the directory itself).
 *
 * Returns a `GeneratedFilesDeleteResponse` with a count and message.
 */
export function deleteGeneratedFiles(workingDir: string, outputPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem

    const absoluteOutputPath = yield* resolveToAbsolutePath(workingDir, outputPath)

    // Check if directory exists
    const exists = yield* fs.exists(absoluteOutputPath)
    if (!exists) {
      return {
        success: true,
        deletedCount: 0,
        message: "Output directory does not exist, nothing to delete",
      } satisfies GeneratedFilesDeleteResponse
    }

    // Count files before deletion for the response
    const fileCount = yield* countFilesInDirectory(absoluteOutputPath)

    // Delete all contents of the directory
    const entries = yield* fs.readdir(absoluteOutputPath)
    for (const entryName of entries) {
      const entryPath = path.join(absoluteOutputPath, entryName)
      yield* fs.rm(entryPath, { recursive: true, force: true })
    }

    return {
      success: true,
      deletedCount: fileCount,
      message: `Successfully deleted ${fileCount} file(s) from ${absoluteOutputPath}`,
    } satisfies GeneratedFilesDeleteResponse
  })
}
