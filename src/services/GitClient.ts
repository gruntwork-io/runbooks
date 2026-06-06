import { Context, Effect } from "effect"
import type { GitError } from "../errors/index.ts"

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

export interface DiffEntry {
  readonly path: string
  readonly changeType: string
  readonly additions: number
  readonly deletions: number
  readonly originalContent?: string
  readonly newContent?: string
  readonly isBinary: boolean
  readonly diffTruncated: boolean
}

export interface StatusEntry {
  readonly path: string
  readonly status: string
}

export interface GitInfo {
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
  readonly cloneSimple: (url: string, dest: string, options?: CloneOptions) => Effect.Effect<CloneResult, GitError>
  readonly push: (repoPath: string, remote: string, branch: string, options?: PushOptions) => Effect.Effect<void, GitError>
  readonly deleteBranch: (repoPath: string, branch: string) => Effect.Effect<void, GitError>
  readonly getCurrentBranch: (repoPath: string) => Effect.Effect<string, GitError>
  readonly getRemoteUrl: (repoPath: string) => Effect.Effect<string, GitError>
  readonly getInfo: (repoPath: string) => Effect.Effect<GitInfo, GitError>
  readonly diff: (repoPath: string, filePath?: string) => Effect.Effect<DiffEntry[], GitError>
  readonly status: (repoPath: string) => Effect.Effect<StatusEntry[], GitError>
  readonly hasCommits: (repoPath: string) => Effect.Effect<boolean, GitError>
  readonly hasChanges: (repoPath: string) => Effect.Effect<boolean, GitError>
  readonly checkIgnored: (repoPath: string, paths: string[]) => Effect.Effect<Set<string>, GitError>
  readonly createBranch: (repoPath: string, branch: string) => Effect.Effect<void, GitError>
  readonly stageAll: (repoPath: string, excludePaths?: string[]) => Effect.Effect<void, GitError>
  readonly commit: (repoPath: string, message: string, options?: CommitOptions) => Effect.Effect<void, GitError>
}

export class GitClient extends Context.Tag("GitClient")<GitClient, GitClientShape>() {}
