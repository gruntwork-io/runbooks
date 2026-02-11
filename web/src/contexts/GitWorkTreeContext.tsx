import { useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useSession } from './useSession'
import { GitWorkTreeContext } from './gitWorkTreeTypes'
import type { GitWorkTree, GitWorkTreeContextType } from './gitWorkTreeTypes'

export type { GitWorkTree, GitWorkTreeContextType }

interface GitWorkTreeProviderProps {
  children: ReactNode
}

export const GitWorkTreeProvider: React.FC<GitWorkTreeProviderProps> = ({ children }) => {
  const [workTrees, setWorkTrees] = useState<GitWorkTree[]>([])
  const [activeWorkTreeId, setActiveWorkTreeId] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const { getAuthHeader } = useSession()

  const invalidateTree = useCallback(() => {
    setTreeVersion(v => v + 1)
  }, [])

  // Sync the active worktree path to the backend so that target="worktree"
  // templates and REPO_FILES point to the correct repo.
  const syncActiveToBackend = useCallback((path: string) => {
    fetch('/api/workspace/set-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ path }),
    }).catch(() => {})
  }, [getAuthHeader])

  const registerWorkTree = useCallback((workTree: GitWorkTree) => {
    setWorkTrees(prev => {
      const existing = prev.findIndex(wt => wt.id === workTree.id)
      if (existing >= 0) {
        const updated = [...prev]
        updated[existing] = workTree
        return updated
      }
      return [...prev, workTree]
    })

    // Auto-activate the first registered worktree
    setActiveWorkTreeId(prev => {
      if (prev === null) {
        // First worktree: set it as active on the backend too
        syncActiveToBackend(workTree.localPath)
        return workTree.id
      }
      return prev
    })

    // Register the worktree path with the backend
    fetch('/api/workspace/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ path: workTree.localPath }),
    }).catch(() => {})

    // Always invalidate the tree so re-clones refresh the file tree and reset changed files
    invalidateTree()
  }, [getAuthHeader, syncActiveToBackend, invalidateTree])

  const setActiveWorkTree = useCallback((id: string) => {
    setActiveWorkTreeId(id)

    // Find the worktree's local path and sync to the backend
    setWorkTrees(prev => {
      const wt = prev.find(w => w.id === id)
      if (wt) syncActiveToBackend(wt.localPath)
      return prev // no mutation, just reading
    })
  }, [syncActiveToBackend])

  const activeWorkTree = useMemo(() => {
    if (!activeWorkTreeId) return null
    return workTrees.find(wt => wt.id === activeWorkTreeId) ?? null
  }, [workTrees, activeWorkTreeId])

  const value = useMemo<GitWorkTreeContextType>(() => ({
    workTrees,
    activeWorkTreeId,
    activeWorkTree,
    registerWorkTree,
    setActiveWorkTree,
    treeVersion,
    invalidateTree,
  }), [workTrees, activeWorkTreeId, activeWorkTree, registerWorkTree, setActiveWorkTree, treeVersion, invalidateTree])

  return (
    <GitWorkTreeContext.Provider value={value}>
      {children}
    </GitWorkTreeContext.Provider>
  )
}
