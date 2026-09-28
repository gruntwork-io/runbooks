import { createContext } from 'react'

/**
 * A file change in the workspace (from git status + diff).
 */
export interface WorkspaceFileChange {
  path: string
  changeType: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  originalContent?: string
  newContent?: string
  language: string
  isBinary?: boolean
  diffTruncated?: boolean
  isDirectory?: boolean
  sourceBlockId?: string
  sourceBlockType?: string
}

/**
 * A workspace tree node (structure only, no content).
 */
export interface WorkspaceTreeNode {
  id: string
  name: string
  type: 'file' | 'folder'
  size?: number
  language?: string
  isBinary?: boolean
  isIgnored?: boolean
  isLazyLoad?: boolean
  children?: WorkspaceTreeNode[]
}

export interface GitFileChangesContextType {
  changes: WorkspaceFileChange[]
  totalChanges: number
  tooManyChanges: boolean
  isLoading: boolean
  /** Fetch the full diff for a single file that was truncated */
  fetchFileDiff: (filePath: string) => Promise<void>
}

export interface GitFileTreeContextType {
  tree: WorkspaceTreeNode[] | null
  isLoading: boolean
  error: string | null
  totalFiles: number
  refetch: () => void
  /** Fetch children for a lazy-loaded folder and merge them into the tree. */
  fetchSubtree: (nodeId: string) => Promise<void>
}

export const GitFileChangesContext = createContext<GitFileChangesContextType | undefined>(undefined)
export const GitFileTreeContext = createContext<GitFileTreeContextType | undefined>(undefined)
