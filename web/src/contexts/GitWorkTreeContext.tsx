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
  /** Git metadata: branch, commit, owner, repoName */
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
}

const GitWorkTreeContext = React.createContext<GitWorkTreeContextType | undefined>(undefined)

interface GitWorkTreeProviderProps {
  children: ReactNode
}

export const GitWorkTreeProvider: React.FC<GitWorkTreeProviderProps> = ({ children }) => {
  const [workTrees, setWorkTrees] = useState<GitWorkTree[]>([])
  const [activeWorkTreeId, setActiveWorkTreeId] = useState<string | null>(null)
  const { getAuthHeader } = useSession()

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
    setActiveWorkTreeId(prev => prev ?? workTree.id)

    // Register the worktree path with the backend for provenance tracking
    fetch('/api/workspace/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ path: workTree.localPath }),
    }).catch(() => {
      // Non-critical: provenance will just not be tracked
    })
  }, [getAuthHeader])

  const setActiveWorkTree = useCallback((id: string) => {
    setActiveWorkTreeId(id)
  }, [])

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
  }), [workTrees, activeWorkTreeId, activeWorkTree, registerWorkTree, setActiveWorkTree])

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
