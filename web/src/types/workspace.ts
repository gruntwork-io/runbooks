/**
 * @fileoverview Types for the Files Workspace
 *
 * Defines types for git workspace and workspace metadata.
 */

/**
 * Git repository information
 */
export interface GitRepoInfo {
  /** Repository URL (e.g., "github.com/gruntwork-io/terraform-aws-lambda") */
  repoUrl: string;
  /** Repository name (e.g., "terraform-aws-lambda") */
  repoName: string;
  /** Repository owner (e.g., "gruntwork-io") */
  repoOwner: string;
  /** Git ref: branch name, tag name, or commit SHA */
  ref: string;
  /** Type of ref: "branch", "tag", or "commit" */
  refType?: 'branch' | 'tag' | 'commit';
  /** Commit SHA */
  commitSha?: string;
}

/**
 * Top-level context for the files workspace
 */
export type WorkspaceContext = 'repository' | 'generated';

/**
 * Tab identifiers for the files workspace
 */
export type WorkspaceTab = 'generated' | 'all' | 'changed';
