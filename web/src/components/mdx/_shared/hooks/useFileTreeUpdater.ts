import { useCallback } from 'react'
import { useGeneratedFiles } from '@/hooks/useGeneratedFiles'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import type { FileTreeResponse } from '@/contexts/GeneratedFilesContext.types'

export function useFileTreeUpdater(target?: 'generated' | 'worktree') {
  // "update" sets new state directly — the API response already contains the full tree data.
  // "invalidate" marks the tree as stale so it gets refetched — we don't have the data inline.
  const { updateGeneratedFileTree } = useGeneratedFiles()
  const { invalidateGitFileTree } = useGitWorkTree()

  const applyFileTreeUpdate = useCallback((result: FileTreeResponse | null) => {
    if (!result) return
    if (target === 'worktree') {
      // "worktree" means files were written directly into the cloned git repo,
      // so we only need to refresh the git file tree (no generated files to update).
      invalidateGitFileTree()
    } else {
      // "generated" (default) means files were written to the generated files directory,
      // so update the generated file tree and also refresh the git file tree.
      updateGeneratedFileTree(result)
      invalidateGitFileTree()
    }
  }, [target, updateGeneratedFileTree, invalidateGitFileTree])

  return { applyFileTreeUpdate }
}
