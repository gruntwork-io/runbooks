import { useContext } from 'react'
import { GitWorkspaceContext } from './GitWorkspaceContext.types'

export function useGitWorkspace() {
  const context = useContext(GitWorkspaceContext)
  if (context === undefined) {
    throw new Error('useGitWorkspace must be used within a GitWorkspaceProvider')
  }
  return context
}
