import { useCallback } from 'react'
import { useGeneratedFiles } from '@/hooks/useGeneratedFiles'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import type { FileTreeResponse } from '@/contexts/GeneratedFilesContext.types'

export function useFileTreeUpdater(target?: 'generated' | 'worktree') {
  const { updateFileTree } = useGeneratedFiles()
  const { invalidateTree } = useGitWorkTree()

  const applyFileTreeUpdate = useCallback((result: FileTreeResponse | null) => {
    if (!result) return
    if (target === 'worktree') {
      invalidateTree()
    } else {
      updateFileTree(result)
      invalidateTree()
    }
  }, [target, updateFileTree, invalidateTree])

  return { applyFileTreeUpdate }
}
