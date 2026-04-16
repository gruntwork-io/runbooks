/**
 * Recursively scans a directory and returns a `FileTreeResult` with content
 * inlined for non-binary files under 512 KB. Enforces a 500-file limit and
 * reports heavy directories (threshold 300 files) so the frontend can warn
 * about large output directories.
 */

import path from "path"
import { Effect } from "effect"

import { FileSystem } from "../../services/FileSystem.ts"
import type { FileReadError, FileNotFoundError } from "../../errors/index.ts"
import {
  type FileTreeNode,
  type FileTreeResult,
  type HeavyDir,
  MAX_FILE_TREE_FILES,
  MAX_FILE_CONTENT_SIZE,
  HEAVY_DIR_THRESHOLD,
} from "../../types.ts"
import { getLanguageFromExtension } from "./file.ts"

// ---------------------------------------------------------------------------
// VCS directories to skip
// ---------------------------------------------------------------------------

const VCS_DIRS = new Set([".git", ".svn", ".hg"])

// ---------------------------------------------------------------------------
// Binary extension detection
// ---------------------------------------------------------------------------

/** Extensions that indicate a binary (non-text) file. */
const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".rar", ".jar", ".war", ".ear",
  ".exe", ".dll", ".so", ".dylib",
  ".bin", ".dat", ".o", ".a",
  ".wasm", ".class", ".pyc", ".pyo",
  ".ico", ".ttf", ".woff", ".woff2", ".eot", ".otf",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv",
  ".wav", ".flac", ".ogg", ".m4a",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
])

/** Returns `true` when the lowercase extension indicates a binary file. */
export function isBinaryExt(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext)
}

// ---------------------------------------------------------------------------
// Internal stats tracker
// ---------------------------------------------------------------------------

interface FileTreeStats {
  totalFiles: number
  dirFileCounts: Map<string, number>
}

// ---------------------------------------------------------------------------
// Recursive builder
// ---------------------------------------------------------------------------

/**
 * Internal recursive directory walker that shares a single stats counter
 * across all levels of recursion.
 */
const buildRecursive = (
  rootPath: string,
  relativePath: string,
  stats: FileTreeStats,
): Effect.Effect<FileTreeNode[], FileReadError | FileNotFoundError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const fullPath = path.join(rootPath, relativePath)

    const rawEntries = yield* fs.readdirWithTypes(fullPath)

    // Sort: directories first, then files, alphabetically within each group
    const entries = [...rawEntries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    const result: FileTreeNode[] = []

    for (const entry of entries) {
      const entryName = entry.name

      // Skip VCS metadata directories
      if (entry.isDirectory && VCS_DIRS.has(entryName)) {
        continue
      }

      const entryRelPath = relativePath
        ? path.join(relativePath, entryName)
        : entryName
      const entryFullPath = path.join(rootPath, entryRelPath)

      if (entry.isDirectory) {
        const children = yield* buildRecursive(rootPath, entryRelPath, stats)
        result.push({
          id: entryRelPath,
          name: entryName,
          type: "folder",
          children,
        })
      } else {
        stats.totalFiles++

        // Track file counts per top-level subdirectory for heavy dir detection
        if (relativePath !== "") {
          const topDir = entryRelPath.split(path.sep)[0]
          stats.dirFileCounts.set(
            topDir,
            (stats.dirFileCounts.get(topDir) ?? 0) + 1,
          )
        }

        // Beyond the file limit: still count but skip reading content
        if (stats.totalFiles > MAX_FILE_TREE_FILES) {
          continue
        }

        const fileStat = yield* fs.stat(entryFullPath)
        const fileSize = fileStat.size
        const ext = path.extname(entryName).toLowerCase()

        // Oversized or binary files: include metadata but no inline content
        if (fileSize > MAX_FILE_CONTENT_SIZE || isBinaryExt(ext)) {
          result.push({
            id: entryRelPath,
            name: entryName,
            type: "file",
            children: [],
            file: {
              name: entryName,
              path: entryRelPath,
              content: "",
              language: getLanguageFromExtension(entryName),
              size: fileSize,
              isTruncated: true,
            },
          })
        } else {
          // Read inline content for small text files
          const content = yield* fs.readFile(entryFullPath)

          result.push({
            id: entryRelPath,
            name: entryName,
            type: "file",
            children: [],
            file: {
              name: entryName,
              path: entryRelPath,
              content,
              language: getLanguageFromExtension(entryName),
              size: fileSize,
              isTruncated: false,
            },
          })
        }
      }
    }

    return result
  })

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a file tree rooted at `rootPath`, reading file content inline where
 * possible. Returns a `FileTreeResult` containing the tree and truncation
 * metadata.
 *
 * Behaviour:
 * - Maximum 500 files are included with inline content.
 * - Files larger than 512 KB or with binary extensions are marked as truncated.
 * - VCS directories (.git, .svn, .hg) are skipped entirely.
 * - Entries are sorted alphabetically with directories before files.
 * - Heavy directories (>=300 files in a top-level subdirectory) are reported
 *   in the metadata so the frontend can surface warnings.
 */
export const buildFileTree = (
  rootPath: string,
): Effect.Effect<FileTreeResult, FileReadError | FileNotFoundError, FileSystem> =>
  Effect.gen(function* () {
    const stats: FileTreeStats = {
      totalFiles: 0,
      dirFileCounts: new Map(),
    }

    const tree = yield* buildRecursive(rootPath, "", stats)

    const truncatedTree = stats.totalFiles > MAX_FILE_TREE_FILES

    let heavyDirs: HeavyDir[] = []
    if (truncatedTree) {
      heavyDirs = Array.from(stats.dirFileCounts.entries())
        .filter(([, count]) => count >= HEAVY_DIR_THRESHOLD)
        .map(([dirPath, fileCount]) => ({ path: dirPath, fileCount }))
        .sort((a, b) => b.fileCount - a.fileCount)
    }

    return {
      tree,
      meta: {
        totalFiles: stats.totalFiles,
        truncatedTree,
        heavyDirs,
      },
    }
  })
