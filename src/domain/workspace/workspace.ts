/**
 * Workspace operations.
 *
 * Provides structure-only file trees with gitignore awareness, directory
 * listing, single-file reading (with binary/image detection), and git
 * change/diff retrieval for workspace directories.
 */

import path from "path"
import { Effect } from "effect"

import { FileSystem } from "../../services/FileSystem.ts"
import { GitClient } from "../../services/GitClient.ts"
import type {
  FileNotFoundError,
  FileReadError,
  GitError,
} from "../../errors/index.ts"
import {
  type WorkspaceTreeNode,
  type WorkspaceTreeResponse,
  type WorkspaceFileResponse,
  type WorkspaceFileChange,
  type WorkspaceChangesResponse,
  MAX_WORKSPACE_FILES,
  MAX_DIFF_SIZE_PER_FILE,
  MAX_CHANGED_FILES,
  MAX_DIR_ENTRIES,
  MAX_FILE_CONTENT_SIZE,
} from "../../types.ts"
import { getLanguageFromExtension, VCS_DIRS } from "./file.ts"

// ---------------------------------------------------------------------------
// Image extensions -- rendered inline as base64 data URIs
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
}

// ---------------------------------------------------------------------------
// Binary extensions -- non-text, non-image files
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
  ".rar", ".jar", ".war", ".ear",
  // Executables / object files
  ".exe", ".dll", ".so", ".dylib",
  ".bin", ".dat", ".o", ".a",
  // Bytecode / compiled
  ".wasm", ".class", ".pyc", ".pyo",
  // Fonts
  ".ico", ".ttf", ".woff", ".woff2", ".eot", ".otf",
  // Office documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // Media -- audio
  ".mp3", ".wav", ".flac", ".ogg", ".m4a",
  // Media -- video
  ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv",
])

/**
 * Text-based image formats (e.g. SVG is XML) -- these should be treated as
 * text for diffing purposes even though they render as images.
 */
const TEXT_BASED_IMAGE_EXTENSIONS = new Set([".svg"])

/**
 * Returns `true` when the lowercase extension indicates a binary (non-text)
 * file. SVG is explicitly excluded since it is XML-based text.
 */
function isBinaryExt(ext: string): boolean {
  if (TEXT_BASED_IMAGE_EXTENSIONS.has(ext)) {
    return false
  }
  return BINARY_EXTENSIONS.has(ext) || ext in IMAGE_EXTENSIONS
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count newlines + 1 (matches Go `countLines`). Returns 0 for empty strings. */
function countLines(s: string): number {
  if (s === "") return 0
  return (s.match(/\n/g)?.length ?? 0) + 1
}

/**
 * Parse a git status porcelain code (two-character XY) into a human-readable
 * change type.
 */
function parseGitStatusCode(code: string): string {
  const x = code.charAt(0)
  const y = code.charAt(1)

  if (x === "?" && y === "?") return "added"
  if (x === "D" || y === "D") return "deleted"
  if (x === "A") return "added"
  if (x === "M" || y === "M" || x === "R" || y === "R") return "modified"

  return "modified"
}

// ---------------------------------------------------------------------------
// getWorkspaceTree
// ---------------------------------------------------------------------------

/**
 * Build a structure-only file tree (no file content) for a workspace
 * directory. Respects .gitignore via batch `git check-ignore` at each
 * directory level. Directories with more than 500 immediate entries are
 * flagged as lazy-load and not recursed into.
 *
 * Fails when the workspace contains more than 10 000 files.
 */
export const getWorkspaceTree = (
  worktreePath: string,
): Effect.Effect<
  WorkspaceTreeResponse,
  FileReadError | FileNotFoundError | GitError,
  FileSystem | GitClient
> =>
  Effect.gen(function* () {
    const fileCount = { value: 0 }

    const tree = yield* buildWorkspaceTreeRecursive(
      worktreePath,
      "",
      fileCount,
    )

    // Attempt to retrieve git metadata (non-fatal)
    const gitInfo = yield* Effect.either(getGitInfo(worktreePath))

    return {
      tree,
      totalFiles: fileCount.value,
      gitInfo: gitInfo._tag === "Right" ? gitInfo.right : undefined,
    }
  })

// ---------------------------------------------------------------------------
// Recursive tree builder (structure only)
// ---------------------------------------------------------------------------

const buildWorkspaceTreeRecursive = (
  rootPath: string,
  relativePath: string,
  fileCount: { value: number },
): Effect.Effect<
  WorkspaceTreeNode[],
  FileReadError | FileNotFoundError | GitError,
  FileSystem | GitClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const git = yield* GitClient
    const fullPath = path.join(rootPath, relativePath)

    const rawEntries = yield* fs.readdirWithTypes(fullPath)

    // Sort: directories first, then files, alphabetically
    const entries = [...rawEntries].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    // Batch gitignore check for all entries at this level
    const pathsToCheck: string[] = entries.map((entry) => {
      const relPath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name
      return entry.isDirectory ? relPath + "/" : relPath
    })

    const ignoredSet = yield* Effect.either(
      git.checkIgnored(rootPath, pathsToCheck),
    )
    const ignored =
      ignoredSet._tag === "Right" ? ignoredSet.right : new Set<string>()

    const result: WorkspaceTreeNode[] = []

    for (const entry of entries) {
      const name = entry.name

      // Skip VCS metadata directories
      if (entry.isDirectory && VCS_DIRS.has(name)) {
        continue
      }

      const entryRelPath = relativePath
        ? path.join(relativePath, name)
        : name

      // Normalize the check path to match what we sent to checkIgnored
      const checkPath = entry.isDirectory ? entryRelPath + "/" : entryRelPath
      const isIgnored = ignored.has(checkPath) || ignored.has(entryRelPath)

      if (entry.isDirectory) {
        // Check if directory is too large for upfront loading
        const isDirLarge = yield* checkDirLarge(
          path.join(fullPath, name),
        )

        if (isIgnored || isDirLarge) {
          result.push({
            id: entryRelPath,
            name,
            type: "folder",
            size: 0,
            language: "",
            isBinary: false,
            isIgnored,
            isLazyLoad: true,
            children: [],
          })
          continue
        }

        const children = yield* buildWorkspaceTreeRecursive(
          rootPath,
          entryRelPath,
          fileCount,
        )

        result.push({
          id: entryRelPath,
          name,
          type: "folder",
          size: 0,
          language: "",
          isBinary: false,
          isIgnored: false,
          isLazyLoad: false,
          children,
        })
      } else {
        fileCount.value++

        if (fileCount.value > MAX_WORKSPACE_FILES) {
          return yield* Effect.fail(
            new FileReadError({
              path: fullPath,
              cause: `too many files: exceeded limit of ${MAX_WORKSPACE_FILES}`,
            }),
          )
        }

        // Get file info for size
        const entryFullPath = path.join(rootPath, entryRelPath)
        const fileStat = yield* Effect.either(fs.stat(entryFullPath))

        const size =
          fileStat._tag === "Right" ? fileStat.right.size : 0
        const ext = path.extname(name).toLowerCase()

        result.push({
          id: entryRelPath,
          name,
          type: "file",
          size,
          language: getLanguageFromExtension(name),
          isBinary: isBinaryExt(ext),
          isIgnored,
          isLazyLoad: false,
          children: [],
        })
      }
    }

    return result
  })

/**
 * Returns `true` when the directory has more than `MAX_DIR_ENTRIES` immediate
 * children, indicating it should be lazy-loaded on the frontend.
 */
const checkDirLarge = (
  dirPath: string,
): Effect.Effect<boolean, FileReadError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const entries = yield* Effect.either(fs.readdir(dirPath))
    if (entries._tag === "Left") return false
    return entries.right.length > MAX_DIR_ENTRIES
  })

// ---------------------------------------------------------------------------
// getWorkspaceDirs
// ---------------------------------------------------------------------------

/**
 * Return the immediate subdirectory names of a workspace path, sorted
 * alphabetically. Hidden directories (starting with `.`) are excluded.
 */
export const getWorkspaceDirs = (
  worktreePath: string,
): Effect.Effect<string[], FileReadError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const entries = yield* fs.readdirWithTypes(worktreePath)

    const dirs = entries
      .filter((e) => e.isDirectory && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort()

    return dirs
  })

// ---------------------------------------------------------------------------
// readWorkspaceFile
// ---------------------------------------------------------------------------

/**
 * Read a single file from the workspace, handling binary detection, image
 * detection (with base64 data URI generation), and size limits.
 */
export const readWorkspaceFile = (
  worktreePath: string,
  filePath: string,
): Effect.Effect<
  WorkspaceFileResponse,
  FileNotFoundError | FileReadError,
  FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const fullPath = path.join(worktreePath, filePath)
    const stat = yield* fs.stat(fullPath)
    const language = getLanguageFromExtension(path.basename(filePath))
    const ext = path.extname(filePath).toLowerCase()

    // Too large to serve
    if (stat.size > MAX_FILE_CONTENT_SIZE) {
      return {
        path: filePath,
        content: "",
        language,
        size: stat.size,
        isImage: false,
        isBinary: false,
        isTooLarge: true,
      }
    }

    // Image file -- return as base64 data URI
    const mimeType = IMAGE_EXTENSIONS[ext]
    if (mimeType) {
      const buffer = yield* fs.readFileBuffer(fullPath)
      const base64 = buffer.toString("base64")
      const dataUri = `data:${mimeType};base64,${base64}`

      return {
        path: filePath,
        content: "",
        language,
        size: stat.size,
        isImage: true,
        isBinary: false,
        isTooLarge: false,
        mimeType,
        dataUri,
      }
    }

    // Known binary extension
    if (BINARY_EXTENSIONS.has(ext)) {
      return {
        path: filePath,
        content: "",
        language,
        size: stat.size,
        isImage: false,
        isBinary: true,
        isTooLarge: false,
      }
    }

    // Read as text and check for null bytes in first 8 KB
    const buffer = yield* fs.readFileBuffer(fullPath)
    const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
    if (probe.includes(0)) {
      return {
        path: filePath,
        content: "",
        language,
        size: stat.size,
        isImage: false,
        isBinary: true,
        isTooLarge: false,
      }
    }

    return {
      path: filePath,
      content: buffer.toString("utf-8"),
      language,
      size: stat.size,
      isImage: false,
      isBinary: false,
      isTooLarge: false,
    }
  })

// ---------------------------------------------------------------------------
// getWorkspaceChanges
// ---------------------------------------------------------------------------

/**
 * Retrieve the list of changed files in a git workspace. For each changed
 * file the original and new content are included (subject to size limits),
 * along with line-level addition/deletion counts.
 *
 * When more than 500 files have changed, the response includes only
 * lightweight metadata and sets `tooManyChanges` to `true`.
 *
 * An optional `singleFile` parameter restricts the response to a single
 * file diff (no size limit).
 */
export const getWorkspaceChanges = (
  worktreePath: string,
  singleFile?: string,
): Effect.Effect<
  WorkspaceChangesResponse,
  FileReadError | FileNotFoundError | GitError,
  FileSystem | GitClient
> =>
  Effect.gen(function* () {
    const git = yield* GitClient

    // Single-file mode
    if (singleFile) {
      const change = yield* getSingleFileDiff(worktreePath, singleFile)
      return {
        changes: [change],
        totalChanges: 1,
        tooManyChanges: false,
      }
    }

    // Bulk mode: get all status entries
    const statusEntries = yield* git.status(worktreePath)

    if (statusEntries.length === 0) {
      return { changes: [], totalChanges: 0, tooManyChanges: false }
    }

    const totalChanges = statusEntries.length
    const tooManyChanges = totalChanges > MAX_CHANGED_FILES

    if (tooManyChanges) {
      return { changes: [], totalChanges, tooManyChanges: true }
    }

    const changes: WorkspaceFileChange[] = []

    for (const entry of statusEntries) {
      let filePath = entry.path

      // Handle renamed files (old -> new)
      if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ")
        filePath = parts[1]
      }

      const changeType = parseGitStatusCode(entry.status)
      const ext = path.extname(filePath).toLowerCase()
      const binary = isBinaryExt(ext)

      const change: WorkspaceFileChange = {
        path: filePath,
        changeType,
        language: getLanguageFromExtension(filePath),
        additions: 0,
        deletions: 0,
        isBinary: binary,
        diffTruncated: false,
      }

      // In binary mode, skip file I/O
      if (binary) {
        changes.push(change)
        continue
      }

      // Populate diff content
      yield* populateDiffContent(worktreePath, change)

      // Enforce per-file size limit
      const totalDiffSize =
        (change.originalContent?.length ?? 0) +
        (change.newContent?.length ?? 0)
      if (totalDiffSize > MAX_DIFF_SIZE_PER_FILE) {
        change.originalContent = undefined
        change.newContent = undefined
        change.diffTruncated = true
      }

      changes.push(change)
    }

    return { changes, totalChanges, tooManyChanges: false }
  })

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve the full diff for a single file (no per-file size limit).
 */
const getSingleFileDiff = (
  worktreePath: string,
  filePath: string,
): Effect.Effect<
  WorkspaceFileChange,
  FileReadError | FileNotFoundError | GitError,
  FileSystem | GitClient
> =>
  Effect.gen(function* () {
    const git = yield* GitClient

    // Determine change type from status
    const statusEntries = yield* git.status(worktreePath)
    let changeType = "modified"
    const match = statusEntries.find((e) => {
      const p = e.path.includes(" -> ")
        ? e.path.split(" -> ")[1]
        : e.path
      return p === filePath
    })
    if (match) {
      changeType = parseGitStatusCode(match.status)
    }

    const ext = path.extname(filePath).toLowerCase()
    const change: WorkspaceFileChange = {
      path: filePath,
      changeType,
      language: getLanguageFromExtension(filePath),
      additions: 0,
      deletions: 0,
      isBinary: isBinaryExt(ext),
      diffTruncated: false,
    }

    if (!change.isBinary) {
      yield* populateDiffContent(worktreePath, change)
    }

    return change
  })

/**
 * Fill in the original/new content and line counts for a file change.
 * Mutates the provided `change` object in-place.
 */
const populateDiffContent = (
  worktreePath: string,
  change: WorkspaceFileChange,
): Effect.Effect<
  void,
  FileReadError | FileNotFoundError | GitError,
  FileSystem | GitClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const git = yield* GitClient
    const absFilePath = path.join(worktreePath, change.path)

    // Git reports untracked directories / embedded git repos as a single entry
    // with a trailing slash, even with --untracked-files=all. Reading one as a
    // file throws EISDIR; flag it and skip file I/O so a single embedded repo
    // can't fail the whole workspace:changes batch (polled every 3s → error loop).
    if (change.path.endsWith("/")) {
      ;(change as { isDirectory: boolean }).isDirectory = true
      return
    }

    switch (change.changeType) {
      case "added": {
        // Defense-in-depth: any unreadable path (an EISDIR we missed, EACCES, a
        // TOCTOU race) degrades to empty content instead of failing the batch —
        // mirroring the "modified" branch below.
        const contentResult = yield* Effect.either(fs.readFile(absFilePath))
        if (contentResult._tag === "Right") {
          ;(change as { newContent: string }).newContent = contentResult.right
          ;(change as { additions: number }).additions = countLines(
            contentResult.right,
          )
        }
        break
      }

      case "deleted": {
        // Get original content from HEAD
        const diffEntries = yield* git.diff(worktreePath, change.path)
        const entry = diffEntries.find((d) => d.path === change.path)
        if (entry?.originalContent) {
          ;(change as { originalContent: string }).originalContent =
            entry.originalContent
          ;(change as { deletions: number }).deletions = countLines(
            entry.originalContent,
          )
        }
        break
      }

      case "modified": {
        // Try to get original from git
        const diffEntries = yield* Effect.either(
          git.diff(worktreePath, change.path),
        )

        if (diffEntries._tag === "Right") {
          const entry = diffEntries.right.find(
            (d) => d.path === change.path,
          )
          if (entry) {
            if (entry.originalContent) {
              ;(change as { originalContent: string }).originalContent =
                entry.originalContent
            }
            ;(change as { additions: number }).additions = entry.additions
            ;(change as { deletions: number }).deletions = entry.deletions
          }
        }

        // Read current file content
        const currentResult = yield* Effect.either(
          fs.readFile(absFilePath),
        )
        if (currentResult._tag === "Right") {
          ;(change as { newContent: string }).newContent =
            currentResult.right
        } else {
          // If the file doesn't exist on disk but git reports it as modified,
          // treat as added
          ;(change as { changeType: string }).changeType = "added"
        }
        break
      }
    }
  })

// ---------------------------------------------------------------------------
// Git info helper
// ---------------------------------------------------------------------------

/**
 * Retrieve git metadata (branch/tag/commit, remote URL, SHA) for a directory.
 */
const getGitInfo = (
  dirPath: string,
): Effect.Effect<
  WorkspaceTreeResponse["gitInfo"],
  GitError,
  GitClient
> =>
  Effect.gen(function* () {
    const git = yield* GitClient

    const info = yield* git.getInfo(dirPath)

    return {
      ref: info.branch,
      refType: info.refType,
      remoteUrl: info.remoteUrl,
      commitSha: info.commitSha,
    }
  })
