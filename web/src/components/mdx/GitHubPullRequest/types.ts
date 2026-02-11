/** Props for the GitHubPullRequest MDX block component */
export interface GitHubPullRequestProps {
  /** Unique block identifier (required) */
  id: string
  /** Display title (supports inline markdown) */
  title?: string
  /** Description text (supports inline markdown) */
  description?: string
  /** Pre-populated PR title (supports template expressions) */
  prefilledPullRequestTitle?: string
  /** Pre-populated PR description (supports template expressions) */
  prefilledPullRequestDescription?: string
  /** Pre-populated label names */
  prefilledPullRequestLabels?: string[]
  /** Pre-populated branch name (supports template expressions) */
  prefilledBranchName?: string
  /** Reference to a GitHubAuth block for token */
  githubAuthId?: string
}

/** Status of the PR block */
export type PRBlockStatus = 'pending' | 'ready' | 'creating' | 'success' | 'fail' | 'pushing'

/** A GitHub label */
export interface GitHubLabel {
  name: string
  color: string
  description?: string
}

/** Result of a successful PR creation */
export interface PRResult {
  prUrl: string
  prNumber: number
  branchName: string
}

/** Summary of workspace file changes for display */
export interface ChangeSummary {
  fileCount: number
  additions: number
  deletions: number
}
