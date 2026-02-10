import React, { useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { useSession } from './useSession'
import type { GitRepoInfo } from '../types/workspace'

/**
 * Represents a single git worktree registered by a GitClone block.
 */
export interface GitWorkTree {
  /** The GitClone block's id */
  id: string
  /** Clone URL (e.g., "https://github.com/gruntwork-io/terraform-aws-lambda") */
  repoUrl: string
  /** Sparse checkout path (if used) */
  repoPath?: string
  /** Absolute local path where the repo was cloned */
  localPath: string
  /** Git metadata: ref, refType, commit, owner, repoName */
  gitInfo: GitRepoInfo
}

/**
 * Context value for managing a collection of git worktrees.
 */
export interface GitWorkTreeContextType {
  /** All registered worktrees */
  workTrees: GitWorkTree[]
  /** ID of the currently active worktree */
  activeWorkTreeId: string | null
  /** The currently active worktree (convenience getter) */
  activeWorkTree: GitWorkTree | null
  /** Register a new worktree (or replace one with the same id) */
  registerWorkTree: (workTree: GitWorkTree) => void
  /** Switch the active worktree by id */
  setActiveWorkTree: (id: string) => void
  /** Monotonically increasing counter that signals "the worktree contents changed, re-fetch the tree".
   *  Any component can call invalidateTree() to bump this; useWorkspaceTree watches it. */
  treeVersion: number
  /** Bump treeVersion to trigger a re-fetch of the workspace file tree */
  invalidateTree: () => void
}

const GitWorkTreeContext = React.createContext<GitWorkTreeContextType | undefined>(undefined)

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
