/**
 * File reading utilities.
 *
 * Provides file metadata reading with truncation, runbook path resolution,
 * language detection from extension, asset extension whitelisting, and
 * MIME-type resolution.
 */

import path from "path"
import { createHash } from "crypto"
import { Effect } from "effect"

import { FileSystem } from "../../services/FileSystem.ts"
import { FileNotFoundError, FileReadError } from "../../errors/index.ts"
import { type FileData, MAX_FILE_CONTENT_SIZE } from "../../types.ts"

/** VCS metadata directories to skip during tree walks. */
export const VCS_DIRS = new Set([".git", ".svn", ".hg"])

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/** Maps lowercase file extensions to language identifiers. */
const LANGUAGE_MAP: Record<string, string> = {
  ".tf": "hcl",
  ".tofu": "hcl",
  ".tfvars": "hcl",
  ".tfstate": "json",
  ".hcl": "hcl",
  ".js": "javascript",
  ".cjs": "javascript",
  ".mjs": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".rb": "ruby",
  ".rs": "rust",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "bash",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".sql": "sql",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".md": "markdown",
  ".mdx": "mdx",
  ".rst": "restructuredtext",
  ".tex": "latex",
  ".dockerfile": "dockerfile",
  ".makefile": "makefile",
  ".cmake": "cmake",
  ".gradle": "gradle",
  ".maven": "xml",
  ".pom": "xml",
  ".properties": "properties",
  ".env": "bash",
  ".gitignore": "gitignore",
  ".gitattributes": "gitattributes",
  ".editorconfig": "ini",
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".tsconfig": "json",
  ".jsconfig": "json",
  ".package": "json",
  ".lock": "text",
  ".log": "text",
  ".txt": "text",
  ".rtf": "text",
  ".csv": "csv",
  ".tsv": "tsv",
  ".diff": "diff",
  ".patch": "diff",
}

/** Special-case basenames (no extension) mapped to languages. */
const BASENAME_LANGUAGE_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  podfile: "ruby",
  vagrantfile: "ruby",
}

// ---------------------------------------------------------------------------
// Asset content types
// ---------------------------------------------------------------------------

/**
 * Allowed asset extensions mapped to their MIME types.
 * Single source of truth for both the whitelist check and content-type header.
 */
const ALLOWED_ASSET_CONTENT_TYPES: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  // Documents
  ".pdf": "application/pdf",
  // Media
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Determine the programming language / syntax identifier for a filename based
 * on its extension, falling back to well-known basenames (Dockerfile, Makefile,
 * etc.). Returns `"text"` when no match is found.
 */
export function getLanguageFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()

  if (ext && LANGUAGE_MAP[ext]) {
    return LANGUAGE_MAP[ext]
  }

  const basename = path.basename(filename).toLowerCase()
  if (BASENAME_LANGUAGE_MAP[basename]) {
    return BASENAME_LANGUAGE_MAP[basename]
  }

  return "text"
}

/**
 * Returns `true` when the file extension is in the whitelist of servable asset
 * types (images, PDFs, media).
 */
export function isAllowedAssetExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return ext in ALLOWED_ASSET_CONTENT_TYPES
}

/**
 * Return the MIME content-type for a filename based on its extension.
 * Falls back to `"application/octet-stream"` for unknown extensions.
 */
export function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return ALLOWED_ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream"
}

/**
 * Compute a SHA-256 hex digest of a string -- used for content hashing.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

// ---------------------------------------------------------------------------
// Effectful operations
// ---------------------------------------------------------------------------

/**
 * Read a file from disk and return its metadata including content (truncated
 * at 512 KB), content hash, detected language, and size.
 */
export const readFileMetadata = (
  filePath: string,
): Effect.Effect<
  FileData & { contentHash: string },
  FileNotFoundError | FileReadError,
  FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const stat = yield* fs.stat(filePath)
    const size = stat.size
    const isTruncated = size > MAX_FILE_CONTENT_SIZE

    const buffer = yield* fs.readFileBuffer(filePath)

    const contentBytes = isTruncated
      ? buffer.subarray(0, MAX_FILE_CONTENT_SIZE)
      : buffer
    const content = contentBytes.toString("utf-8")

    const language = getLanguageFromExtension(path.basename(filePath))
    const contentHash = computeContentHash(content)

    return {
      name: path.basename(filePath),
      path: filePath,
      content,
      contentHash,
      language,
      size,
      isTruncated,
    }
  })

/**
 * Resolve a path that may be either a file or a directory containing a
 * `runbook.mdx` file. If the path points to a directory, looks for
 * `runbook.mdx` inside it.
 *
 * Returns the resolved absolute file path, or fails with
 * `FileNotFoundError` if the runbook cannot be located.
 */
export const resolveRunbookPath = (
  inputPath: string,
): Effect.Effect<string, FileNotFoundError | FileReadError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const stat = yield* fs.stat(inputPath)

    if (stat.isDirectory) {
      const fullPath = path.join(inputPath, "runbook.mdx")
      const exists = yield* fs.exists(fullPath)

      if (!exists) {
        return yield* Effect.fail(
          new FileNotFoundError({ path: fullPath }),
        )
      }

      return fullPath
    }

    // Already a file path
    return inputPath
  })
