/** Props for the GitCommitPush MDX block component. */
export interface GitCommitPushProps {
  /** Unique block identifier (required) */
  id: string
  /** Display title (supports inline markdown) */
  title?: string
  /** Description text (supports inline markdown) */
  description?: string
  /**
   * The pull request block whose pull request the commit goes to. The block
   * shows the pull request, commits on its branch, and works in its clone.
   * Not with `gitCloneId`.
   */
  pullRequestId?: string
  /**
   * The <GitClone> block whose clone holds the changes, for a commit on the
   * branch that clone is on. Needed only when the runbook has more than one
   * clone and none above the block. Not with `pullRequestId`.
   */
  gitCloneId?: string
  /**
   * The commit message (supports template expressions). Left out, the message
   * follows the files chosen until the user edits it.
   */
  commitMessage?: string
  /**
   * The changed files that start chosen, by repo-relative path or folder,
   * with `*` and `**` (supports template expressions). Left out, every file.
   */
  selectedPaths?: string[]
  /** Whether the list of changed files starts open. */
  changedFilesExpanded?: boolean
  /**
   * Show a Merge button for the pull request once GitHub says it can merge.
   * Needs `pullRequestId`. GitHub only.
   */
  allowPullRequestMerge?: boolean
  /**
   * Conditions, by keyword, that must also hold before Merge is enabled, such
   * as "no-uncommitted-changes". Needs `allowPullRequestMerge`.
   */
  allowPullRequestMergeConditions?: string[]
}
