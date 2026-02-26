import { createContext } from 'react'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'

/** Truncation metadata from the backend when the file tree exceeds limits. */
export interface TruncationInfo {
  /** True when the file tree was capped at the display limit */
  truncatedTree: boolean
  /** Total files discovered (including beyond the limit) */
  totalFiles: number
  /** The top-level subdirectory containing the most files (when truncated) */
  heavyDir?: string
  /** Number of files in heavyDir */
  heavyDirFileCount?: number
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
  heavyDir?: string
  heavyDirFileCount?: number
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
