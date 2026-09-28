import { useContext } from 'react'
import { GitFileTreeContext, type GitFileTreeContextType } from '../contexts/WorkspaceGitDataContext.types'

export type { WorkspaceTreeNode } from '../contexts/WorkspaceGitDataContext.types'

/**
 * The structure-only file tree for the active git worktree. Re-fetched
 * automatically when the active worktree changes or treeVersion bumps.
 *
 * The tree is fetched once in WorkspaceGitDataProvider and shared by every
 * caller.
 */
export function useGitFileTree(): GitFileTreeContextType {
  const context = useContext(GitFileTreeContext)
  if (context === undefined) {
    throw new Error('useGitFileTree must be used within a WorkspaceGitDataProvider')
  }
  return context
}
