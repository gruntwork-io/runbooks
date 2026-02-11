import React from 'react'
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

export const GitWorkTreeContext = React.createContext<GitWorkTreeContextType | undefined>(undefined)
