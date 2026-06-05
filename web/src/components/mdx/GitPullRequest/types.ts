import type { GitProvider } from "@/components/mdx/GitAuth/types"

/** Props for the provider-agnostic GitPullRequest MDX block component. */
export interface GitPullRequestProps {
  /** Unique block identifier (required) */
  id: string
  /** Display title (supports inline markdown). Defaults per provider. */
  title?: string
  /** Description text (supports inline markdown) */
  description?: string
  /** Pre-populated PR/MR title (supports template expressions) */
  prefilledPullRequestTitle?: string
  /** Pre-populated PR/MR description (supports template expressions) */
  prefilledPullRequestDescription?: string
  /** Pre-populated label names */
  prefilledPullRequestLabels?: string[]
  /** Pre-populated branch name (supports template expressions) */
  prefilledBranchName?: string
  /** Reference to one or more Inputs by ID for template expressions in props */
  inputsId?: string | string[]
  /**
   * Reference to a legacy GitHubAuth block for credentials. GitHub-specific;
   * kept for back-compat. Prefer `gitAuthId`.
   */
  githubAuthId?: string
  /**
   * Reference to a Git Auth block (GitHub or GitLab) by ID. The block derives
   * the connected instance's provider from this block's GIT_PROVIDER output.
   */
  gitAuthId?: string
  /**
   * Locked provider. The provider-locked wrappers (GitHubPullRequest,
   * GitLabMergeRequest) set this; left undefined the block derives the provider
   * from the linked auth block (or the cloned repo host) and defaults to github.
   */
  provider?: GitProvider
  /**
   * Hide/lock the provider. Set by the wrappers for parity with GitAuth. There
   * is no runtime provider picker in this block (the provider is derived), so
   * this is currently informational.
   */
  hideProviderSelect?: boolean
}

/** Status of the PR/MR block */
export type PRBlockStatus = 'pending' | 'ready' | 'creating' | 'success' | 'fail' | 'pushing'

/** A repository label (GitHub or GitLab) */
export interface GitLabel {
  name: string
  color: string
  description?: string
}

/** Result of a successfully created pull/merge request */
export interface PRResult {
  prUrl: string
  /**
   * The user-facing number: a GitHub PR number, or a GitLab MR **iid**
   * (project-scoped, rendered as `!N`). The block's `PR_ID` output is
   * `String(prNumber)`, so for GitLab `PR_ID` is the iid.
   */
  prNumber: number
  branchName: string
}

/** Summary of workspace file changes for display */
export interface ChangeSummary {
  fileCount: number
  additions: number
  deletions: number
}

// ---------------------------------------------------------------------------
// Back-compat aliases (mirror GitAuth/types.ts). The locked wrappers omit the
// provider controls; `GitHubLabel` is the historical name for `GitLabel`.
// ---------------------------------------------------------------------------

/** Props for the legacy <GitHubPullRequest> wrapper (provider locked to github). */
export type GitHubPullRequestProps = Omit<GitPullRequestProps, 'provider' | 'hideProviderSelect'>
/** Props for the <GitLabMergeRequest> wrapper (provider locked to gitlab). */
export type GitLabMergeRequestProps = Omit<GitPullRequestProps, 'provider' | 'hideProviderSelect'>
/** @deprecated Use {@link GitLabel}. */
export type GitHubLabel = GitLabel
