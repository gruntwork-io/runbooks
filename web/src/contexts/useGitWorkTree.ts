import React from 'react'
import { GitWorkTreeContext } from './gitWorkTreeTypes'
import type { GitWorkTreeContextType } from './gitWorkTreeTypes'

/**
 * Hook to access the git worktree context.
 */
export const useGitWorkTree = (): GitWorkTreeContextType => {
  const context = React.useContext(GitWorkTreeContext)
  if (context === undefined) {
    throw new Error('useGitWorkTree must be used within a GitWorkTreeProvider')
  }
  return context
}
