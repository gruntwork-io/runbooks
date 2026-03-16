import { useCallback } from 'react'
import { useGeneratedFiles } from '@/hooks/useGeneratedFiles'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import type { FileTreeResponse } from '@/contexts/GeneratedFilesContext.types'

export function useFileTreeUpdater(target?: 'generated' | 'worktree') {
  const { updateGeneratedFileTree } = useGeneratedFiles()
  const { invalidateGitFileTree } = useGitWorkTree()

  const applyFileTreeUpdate = useCallback((result: FileTreeResponse | null) => {
    if (!result) return
    if (target === 'worktree') {
      invalidateGitFileTree()
    } else {
      updateGeneratedFileTree(result)
      invalidateGitFileTree()
    }
  }, [target, updateGeneratedFileTree, invalidateGitFileTree])

  return { applyFileTreeUpdate }
}
