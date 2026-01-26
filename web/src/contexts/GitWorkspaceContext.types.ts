import { createContext } from 'react'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'

// Git file status
export interface GitFileStatus {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  oldPath?: string // For renamed files
  additions?: number
  deletions?: number
}

// Workspace info
export interface GitWorkspace {
  id: string          // GitClone block ID
  repo: string        // owner/repo
  branch: string
  workspacePath: string
  commitSha: string
  fileTree: FileTreeNode[] | null
  changedFiles: GitFileStatus[]
  isLoading: boolean
  lastUpdated: Date | null
}

export interface GitWorkspaceContextType {
  // Current workspaces (can have multiple)
  workspaces: Record<string, GitWorkspace>
  
  // Active workspace (the one being viewed)
  activeWorkspaceId: string | null
  setActiveWorkspaceId: (id: string | null) => void
  
  // Workspace management
  registerWorkspace: (workspace: Omit<GitWorkspace, 'fileTree' | 'changedFiles' | 'isLoading' | 'lastUpdated'>) => void
  updateWorkspace: (id: string, updates: Partial<GitWorkspace>) => void
  removeWorkspace: (id: string) => void
  
  // File tree for active workspace
  activeFileTree: FileTreeNode[] | null
  
  // Changed files for active workspace
  activeChangedFiles: GitFileStatus[]
  
  // Refresh workspace status
  refreshWorkspaceStatus: (id: string) => Promise<void>
}

export const GitWorkspaceContext = createContext<GitWorkspaceContextType | undefined>(undefined)
