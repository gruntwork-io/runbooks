import { createContext } from 'react'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'

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
  heavyDirs?: HeavyDir[]
}

/**
 * Shape accepted by updateFileTree. Includes the file tree itself plus optional
 * truncation metadata returned by the backend. When truncation fields are
 * absent the stored TruncationInfo is automatically cleared.
 */
export interface FileTreeResponse {
  fileTree: FileTreeNode[]
  truncatedTree?: boolean
  totalFiles?: number
  heavyDirs?: HeavyDir[]
}

export interface GeneratedFilesContextType {
  fileTree: FileTreeNode[] | null
  truncationInfo: TruncationInfo | null
  localPath: string | null
  setLocalPath: (path: string | null) => void
  /** Single setter for file tree + truncation metadata. Pass null to clear. */
  updateFileTree: (response: FileTreeResponse | null) => void
}

export const GeneratedFilesContext = createContext<GeneratedFilesContextType | undefined>(undefined)
