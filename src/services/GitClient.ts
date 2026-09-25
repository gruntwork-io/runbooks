import { Context, Effect } from "effect"
import type { GitError, SpawnError } from "../errors/index.ts"

export interface CloneOptions {
  readonly ref?: string
  readonly repoPath?: string
  readonly token?: string
  readonly force?: boolean
  /** When set, use sparse checkout to only fetch this subpath within the repo. */
  readonly sparse?: string
}

export interface CloneResult {
  readonly fileCount: number
  readonly absolutePath: string
  readonly relativePath: string
}

export interface PushOptions {
  readonly token?: string
  readonly setUpstream?: boolean
}

/** One file's worktree-vs-HEAD line counts (`git diff HEAD --numstat`). */
export interface DiffEntry {
  readonly path: string
  readonly changeType: string
  readonly additions: number
  readonly deletions: number
  /** The file's content at HEAD; undefined when it has none (new file, unborn branch, binary). */
  readonly originalContent?: string
  readonly isBinary: boolean
}

export interface StatusEntry {
  /** Repo-relative path, verbatim (never C-quoted). For a rename/copy, the new path. */
  readonly path: string
  /** Porcelain v1 XY code, trimmed (e.g. "M", "??", "R"). */
  readonly status: string
  /** For a rename/copy (R/C), the path it came from. */
  readonly origPath?: string
}

export interface GitInfo {
  /**
   * The checked-out ref: the branch name, the tag name when `refType` is
   * "tag", or "HEAD" when `refType` is "detached".
   */
  readonly branch: string
  readonly refType: "branch" | "tag" | "detached"
  readonly remoteUrl?: string
  readonly commitSha?: string
}

/** A git author/committer identity (name + email). */
export interface GitIdentity {
  readonly name: string
  readonly email: string
}

export interface CommitOptions {
  readonly allowEmpty?: boolean
  /**
   * Fallback author identity, used ONLY when the repo can resolve no git
   * identity of its own (no user.name/user.email in any config scope). This is
   * what lets MR/PR creation succeed on a machine where the user never ran
   * `git config` — the commit is attributed to the authenticated GitLab/GitHub
   * user instead of failing with "author identity unknown". When the user HAS
   * configured an identity (local or global), theirs is respected and this is
   * ignored.
   */
  readonly author?: GitIdentity
}

export interface GitClientShape {
  readonly cloneSimple: (url: string, dest: string, options?: CloneOptions) => Effect.Effect<CloneResult, GitError | SpawnError>
  readonly push: (repoPath: string, remote: string, branch: string, options?: PushOptions) => Effect.Effect<void, GitError | SpawnError>
  readonly deleteBranch: (repoPath: string, branch: string) => Effect.Effect<void, GitError | SpawnError>
  readonly getCurrentBranch: (repoPath: string) => Effect.Effect<string, GitError | SpawnError>
  /** Absolute path of the repository root containing `repoPath` (`git rev-parse --show-toplevel`). */
  readonly getRepoRoot: (repoPath: string) => Effect.Effect<string, GitError | SpawnError>
  readonly getRemoteUrl: (repoPath: string) => Effect.Effect<string, GitError | SpawnError>
  readonly getInfo: (repoPath: string) => Effect.Effect<GitInfo, GitError | SpawnError>
  /**
   * Changed tracked files, worktree vs HEAD (staged and unstaged alike), with
   * HEAD content for text files. Omit `filePath` to diff the whole worktree in
   * one pass. On an unborn branch it falls back to worktree vs index.
   */
  readonly diff: (repoPath: string, filePath?: string) => Effect.Effect<DiffEntry[], GitError | SpawnError>
  readonly status: (repoPath: string) => Effect.Effect<StatusEntry[], GitError | SpawnError>
  /**
   * Whether HEAD resolves to a commit. False only for an unborn HEAD (a fresh
   * `git init` or an empty clone); fails when the repo can't be queried.
   */
  readonly hasCommits: (repoPath: string) => Effect.Effect<boolean, GitError | SpawnError>
  readonly hasChanges: (repoPath: string) => Effect.Effect<boolean, GitError | SpawnError>
  readonly checkIgnored: (repoPath: string, paths: string[]) => Effect.Effect<Set<string>, GitError | SpawnError>
  readonly createBranch: (repoPath: string, branch: string) => Effect.Effect<void, GitError | SpawnError>
  readonly stageAll: (repoPath: string, excludePaths?: string[]) => Effect.Effect<void, GitError | SpawnError>
  readonly commit: (repoPath: string, message: string, options?: CommitOptions) => Effect.Effect<void, GitError | SpawnError>
}

export class GitClient extends Context.Tag("GitClient")<GitClient, GitClientShape>() {}
