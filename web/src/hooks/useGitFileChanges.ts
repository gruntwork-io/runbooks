import { useContext } from 'react'
import { GitFileChangesContext, type GitFileChangesContextType } from '../contexts/WorkspaceGitDataContext.types'

export type { WorkspaceFileChange } from '../contexts/WorkspaceGitDataContext.types'

/**
 * Git changes in the active worktree, polled every 3 seconds.
 *
 * The poller lives in WorkspaceGitDataProvider, so every caller shares one
 * `workspace:changes` request per interval and sees the same snapshot.
 */
export function useGitFileChanges(): GitFileChangesContextType {
  const context = useContext(GitFileChangesContext)
  if (context === undefined) {
    throw new Error('useGitFileChanges must be used within a WorkspaceGitDataProvider')
  }
  return context
}
