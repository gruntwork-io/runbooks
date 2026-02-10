/**
 * @fileoverview Types for the Files Workspace
 * 
 * Defines types for git workspace, file changes, and workspace metadata.
 */

import { z } from 'zod'
import type { WorkspaceFileChange } from '@/hooks/useWorkspaceChanges'

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
 * Workspace file with optional modification state
 */
export interface WorkspaceFile {
  /** Unique identifier */
  id: string;
  /** File name */
  name: string;
  /** Full path relative to workspace root */
  path: string;
  /** File content */
  content: string;
  /** Programming language for syntax highlighting */
  language: string;
  /** Original content (if modified) */
  originalContent?: string;
  /** Whether the file has been modified */
  isModified?: boolean;
  /** Whether the file is new (added) */
  isNew?: boolean;
  /** Whether the file is deleted */
  isDeleted?: boolean;
}

/**
 * Workspace file tree node (same structure as FileTreeNode but with workspace-specific fields)
 */
export interface WorkspaceTreeNode {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Type of node */
  type: 'file' | 'folder';
  /** Child nodes (for folders) */
  children?: WorkspaceTreeNode[];
  /** File data (for files) */
  file?: WorkspaceFile;
}

/**
 * Workspace statistics
 */
export interface WorkspaceStats {
  /** Total number of files in workspace */
  totalFiles: number;
  /** Number of generated files */
  generatedFiles: number;
  /** Number of changed files */
  changedFiles: number;
  /** Total lines added */
  totalAdditions: number;
  /** Total lines deleted */
  totalDeletions: number;
}

/**
 * Complete workspace state
 */
export interface WorkspaceState {
  /** Git repository info (null if not connected to a repo) */
  gitInfo: GitRepoInfo | null;
  /** Local path where files are cloned/downloaded */
  localPath?: string;
  /** All files in the workspace */
  files: WorkspaceTreeNode[];
  /** File changes (for Changed tab) */
  changes: WorkspaceFileChange[];
  /** Workspace statistics */
  stats: WorkspaceStats;
  /** Whether workspace is loading */
  isLoading: boolean;
  /** Error message if any */
  error?: string;
}

/**
 * Top-level context for the files workspace
 */
export type WorkspaceContext = 'repository' | 'generated';

/**
 * Tab identifiers for the files workspace
 */
export type WorkspaceTab = 'generated' | 'all' | 'changed';

// Zod schemas for validation

export const GitRepoInfoSchema = z.object({
  repoUrl: z.string(),
  repoName: z.string(),
  repoOwner: z.string(),
  ref: z.string(),
  refType: z.enum(['branch', 'tag', 'commit']).optional(),
  commitSha: z.string().optional(),
})

export const WorkspaceFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  content: z.string(),
  language: z.string(),
  originalContent: z.string().optional(),
  isModified: z.boolean().optional(),
  isNew: z.boolean().optional(),
  isDeleted: z.boolean().optional(),
})

export const FileChangeSchema = z.object({
  id: z.string(),
  path: z.string(),
  changeType: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number(),
  deletions: z.number(),
  originalContent: z.string().optional(),
  newContent: z.string().optional(),
  originalPath: z.string().optional(),
  language: z.string(),
})
