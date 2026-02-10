/** Props for the GitClone MDX block component */
export interface GitCloneProps {
  /** Unique block identifier (required) */
  id: string
  /** Display title (supports inline markdown) */
  title?: string
  /** Description text (supports inline markdown) */
  description?: string
  /** Reference to a GitHubAuth block for token */
  gitHubAuthId?: string
  /** Pre-fill the Git URL input */
  prefilledUrl?: string
  /** Pre-fill the ref (branch or tag) to clone */
  prefilledRef?: string
  /** Pre-fill the sparse checkout path (subdirectory to clone) */
  prefilledRepoPath?: string
  /** Pre-fill the local path (relative to CWD) where files will be cloned */
  prefilledLocalPath?: string
  /** Whether to use PTY (pseudo-terminal) for git clone execution. Defaults to true. Set to false to use pipes instead, which may be needed for environments that don't support PTY. */
  usePty?: boolean
  /** Whether to show the file tree in the workspace panel after cloning. Defaults to true. */
  showFileTree?: boolean
}

/** Status of the clone operation */
export type GitCloneStatus = 'pending' | 'ready' | 'running' | 'success' | 'fail'

/** Result of a successful clone */
export interface CloneResult {
  fileCount: number
  absolutePath: string
  relativePath: string
}

/** A GitHub organization or user account */
export interface GitHubOrg {
  login: string
  avatarUrl: string
  type: 'Organization' | 'User'
}

/** A GitHub repository */
export interface GitHubRepo {
  name: string
  fullName: string
  private: boolean
  description: string
}

/** A GitHub branch */
export interface GitHubBranch {
  name: string
  isDefault: boolean
}
