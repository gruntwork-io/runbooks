import { createContext } from "react"
import type { FileTreeNode } from "../components/artifacts/code/FileTree"
import type { FileChange, ReviewedFiles } from "../lib/fileReview"
import type { SavedFileReview } from "../lib/sessionHistory"

/** A top-level subdirectory that contains a disproportionate number of files. */
export interface HeavyDir {
  /** Directory path relative to the output directory (e.g., "node_modules") */
  path: string
  /** Number of files contained within this directory (recursively) */
  fileCount: number
}

/** Truncation metadata from the backend when the file tree exceeds limits. */
export interface TruncationInfo {
  /** True when the file tree was capped at the display limit */
  truncatedTree: boolean
  /** Total files discovered (including beyond the limit) */
  totalFiles: number
  /** Top-level subdirectories with a significant share of total files, sorted by file count descending */
  heavyDirs?: HeavyDir[] | undefined
}

/**
 * Shape accepted by updateGeneratedFileTree. Includes the file tree itself plus optional
 * truncation metadata returned by the backend. When truncation fields are
 * absent the stored TruncationInfo is automatically cleared.
 */
export interface FileTreeResponse {
  fileTree: FileTreeNode[]
  truncatedTree?: boolean | undefined
  totalFiles?: number | undefined
  heavyDirs?: HeavyDir[] | undefined
}

export interface GeneratedFilesContextType {
  fileTree: FileTreeNode[] | null
  truncationInfo: TruncationInfo | null
  localPath: string | null
  setLocalPath: (path: string | null) => void
  /**
   * Single setter for file tree + truncation metadata. Pass null to clear,
   * which also forgets what the user reviewed.
   *
   * The files that changed since the user last reviewed them are highlighted.
   * Pass `resumed` for the files a resumed session's blocks wrote: what the
   * user had reviewed of them is then what its history saved, and any other
   * file counts as reviewed.
   */
  updateGeneratedFileTree: (
    response: FileTreeResponse | null,
    resumed?: { review: SavedFileReview | undefined },
  ) => void
}

export const GeneratedFilesContext = createContext<GeneratedFilesContextType | undefined>(undefined)

/**
 * Which generated files changed since the user last reviewed them. A file
 * counts as reviewed once the user selects it and then another file, scrolls
 * past its changes, or dismisses it.
 */
export interface GeneratedFilesReviewContextType {
  /** The changes of the files changed since the user reviewed them, by path */
  changes: ReadonlyMap<string, FileChange>
  /** What the user last reviewed of each file (see ReviewedFiles) */
  reviewed: ReviewedFiles
  /**
   * The file the user selected, or null. It stays highlighted while selected,
   * and selecting another marks it reviewed as it is then.
   */
  selectedPath: string | null
  /** Select a file, marking the one selected before it reviewed. */
  selectFile: (path: string) => void
  /** Mark files reviewed. */
  dismissFiles: (paths: readonly string[]) => void
  /** Mark every file reviewed. */
  dismissAll: () => void
}

export const GeneratedFilesReviewContext = createContext<
  GeneratedFilesReviewContextType | undefined
>(undefined)
