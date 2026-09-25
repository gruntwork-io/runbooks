import { useState, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { useApi } from './ApiContext'
import { GitWorkTreeContext } from './gitWorkTreeTypes'
import type { GitWorkTree, GitWorkTreeContextType } from './gitWorkTreeTypes'

interface IpcGitWorkTreeProviderProps {
  children: ReactNode
}

/**
 * Manages registered git worktrees and the active worktree via Electron IPC.
 */
export const IpcGitWorkTreeProvider: React.FC<IpcGitWorkTreeProviderProps> = ({ children }) => {
  const [workTrees, setWorkTreesState] = useState<GitWorkTree[]>([])
  const [activeWorkTreeId, setActiveWorkTreeIdState] = useState<string | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const api = useApi()
  // The latest worktrees and active id, including changes React has not
  // rendered yet. Every change reads and writes these, so two blocks that
  // register and unregister in the same tick each build on the other's change
  // instead of on a stale render.
  const workTreesRef = useRef<GitWorkTree[]>([])
  const activeIdRef = useRef<string | null>(null)
  const setWorkTrees = useCallback((next: GitWorkTree[]) => {
    workTreesRef.current = next
    setWorkTreesState(next)
  }, [])
  const setActiveWorkTreeId = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveWorkTreeIdState(id)
  }, [])
  // The worktree that last lost the active role to unregisterWorkTree (its
  // block started over). When that block registers again it takes the role
  // back, as if it had never left; otherwise, in a runbook with several
  // GitClone blocks, the stand-in would stay active and <GitPullRequest>
  // would target the wrong repository.
  const displacedActiveIdRef = useRef<string | null>(null)

  const invalidateGitFileTree = useCallback(() => {
    setTreeVersion(v => v + 1)
  }, [])

  // Sync the active worktree path to the backend so that target="worktree"
  // templates and REPO_FILES point to the correct repo.
  const syncActiveToBackend = useCallback((path: string) => {
    api.invoke('workspace:set-active', { worktreePath: path }).catch(() => {})
  }, [api])

  const registerWorkTree = useCallback((workTree: GitWorkTree) => {
    const prev = workTreesRef.current
    const existing = prev.findIndex(wt => wt.id === workTree.id)
    setWorkTrees(existing >= 0
      ? prev.map((wt, i) => (i === existing ? workTree : wt))
      : [...prev, workTree])

    const reclaimsActive = displacedActiveIdRef.current === workTree.id
    if (reclaimsActive) displacedActiveIdRef.current = null

    // Auto-activate the first registered worktree, and set it as active on
    // the backend too. Re-registering the active one (its block cloned again,
    // maybe to another path) syncs it again, or the backend would stay on the
    // old path.
    const active = activeIdRef.current
    if (active === null || active === workTree.id || reclaimsActive) {
      setActiveWorkTreeId(workTree.id)
      syncActiveToBackend(workTree.localPath)
    }

    // Register the worktree path with the backend
    api.invoke('workspace:register', { worktreePath: workTree.localPath }).catch(() => {})

    // Always invalidate the tree so re-clones refresh the file tree and reset changed files
    invalidateGitFileTree()
  }, [api, setWorkTrees, setActiveWorkTreeId, syncActiveToBackend, invalidateGitFileTree])

  // Called when a GitClone block starts over. Its worktree must not stay
  // registered (or active) while the block shows no repo: <GitPullRequest>
  // would keep targeting the repository the user moved away from.
  const unregisterWorkTree = useCallback((id: string) => {
    const prev = workTreesRef.current
    const remaining = prev.filter(wt => wt.id !== id)
    if (remaining.length === prev.length) return
    setWorkTrees(remaining)
    if (activeIdRef.current === id) {
      // Keep the original holder when a stand-in is removed in turn.
      displacedActiveIdRef.current ??= id
      const next = remaining[0] ?? null
      setActiveWorkTreeId(next?.id ?? null)
      if (next) syncActiveToBackend(next.localPath)
    }
    invalidateGitFileTree()
  }, [setWorkTrees, setActiveWorkTreeId, syncActiveToBackend, invalidateGitFileTree])

  const setActiveWorkTree = useCallback((id: string) => {
    // An explicit choice wins over handing the role back later.
    displacedActiveIdRef.current = null
    setActiveWorkTreeId(id)

    // Sync the worktree's local path to the backend
    const wt = workTreesRef.current.find(w => w.id === id)
    if (wt) syncActiveToBackend(wt.localPath)
  }, [setActiveWorkTreeId, syncActiveToBackend])

  const activeWorkTree = useMemo(() => {
    if (!activeWorkTreeId) return null
    return workTrees.find(wt => wt.id === activeWorkTreeId) ?? null
  }, [workTrees, activeWorkTreeId])

  // Called when a different runbook is loaded. This provider is mounted once
  // at the app root (main.tsx), so without this, worktrees registered by a
  // GitClone block in one runbook (and its "auto-activate the first one"
  // selection) would silently stick around as "active" after switching to an
  // unrelated runbook in the same running window.
  const resetWorkTrees = useCallback(() => {
    displacedActiveIdRef.current = null
    setWorkTrees([])
    setActiveWorkTreeId(null)
    invalidateGitFileTree()
  }, [setWorkTrees, setActiveWorkTreeId, invalidateGitFileTree])

  const value = useMemo<GitWorkTreeContextType>(() => ({
    workTrees,
    activeWorkTreeId,
    activeWorkTree,
    registerWorkTree,
    unregisterWorkTree,
    setActiveWorkTree,
    resetWorkTrees,
    treeVersion,
    invalidateGitFileTree,
  }), [workTrees, activeWorkTreeId, activeWorkTree, registerWorkTree, unregisterWorkTree, setActiveWorkTree, resetWorkTrees, treeVersion, invalidateGitFileTree])

  return (
    <GitWorkTreeContext.Provider value={value}>
      {children}
    </GitWorkTreeContext.Provider>
  )
}
