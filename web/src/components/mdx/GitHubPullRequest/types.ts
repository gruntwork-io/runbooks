export type PRStatus = 'pending' | 'creating' | 'created' | 'failed'

// Props for the GitHubPullRequest component
export interface GitHubPullRequestProps {
  id: string
  title?: string
  description?: string
  /** Reference to GitHubAuth block */
  githubAuthId?: string
  /** Reference to GitClone block */
  gitCloneId: string
  /** Template for branch name */
  defaultBranchName?: string
  /** Template for commit message */
  defaultCommitMessage?: string
  /** Template for PR title */
  defaultPrTitle?: string
  /** Template for PR body */
  defaultPrBody?: string
  /** PR target branch (default: repo default) */
  targetBranch?: string
  /** Create as draft PR */
  draft?: boolean
}

// PR creation result
export interface PRResult {
  prUrl: string
  prNumber: number
  branchName: string
  commitSha: string
}
