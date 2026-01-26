export type GitCloneStatus = 'pending' | 'cloning' | 'cloned' | 'failed'

// GitHub repository info
export interface GitHubRepo {
  id: number
  name: string
  fullName: string // owner/repo
  description: string | null
  defaultBranch: string
  private: boolean
  htmlUrl: string
}

// GitHub branch info
export interface GitHubBranch {
  name: string
  protected: boolean
}

// Props for the GitClone component
export interface GitCloneProps {
  id: string
  title?: string
  description?: string
  /** Reference to GitHubAuth block for authentication */
  githubAuthId?: string
  /** Pre-configured repository (owner/name) */
  repo?: string
  /** Pre-configured branch */
  branch?: string
  /** Show repo picker (default: true if repo not set) */
  allowRepoSelection?: boolean
  /** Show branch picker (default: true) */
  allowBranchSelection?: boolean
  /** Subdirectory in output path (default: repo name) */
  workspacePath?: string
}

// Clone result
export interface CloneResult {
  workspacePath: string
  repo: string
  branch: string
  commitSha: string
}
