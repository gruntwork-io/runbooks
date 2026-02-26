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

export interface GeneratedFilesContextType {
  fileTree: FileTreeNode[] | null
  setFileTree: (fileTree: FileTreeNode[] | null | ((prevFileTree: FileTreeNode[] | null) => FileTreeNode[] | null)) => void
  localPath: string | null
  setLocalPath: (path: string | null) => void
  truncationInfo: TruncationInfo | null
  setTruncationInfo: (info: TruncationInfo | null) => void
}

export const GeneratedFilesContext = createContext<GeneratedFilesContextType | undefined>(undefined)
