import { Context, Effect, Stream } from "effect"
import type { GitError } from "../errors/index.ts"

export interface CloneOptions {
  readonly ref?: string
  readonly repoPath?: string
  readonly token?: string
  readonly force?: boolean
}

export interface CloneProgress {
  readonly line: string
  readonly timestamp: string
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

export interface GitClientShape {
  readonly clone: (url: string, dest: string, options?: CloneOptions) => Stream.Stream<CloneProgress, GitError>
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
  readonly stageAll: (repoPath: string) => Effect.Effect<void, GitError>
  readonly commit: (repoPath: string, message: string, allowEmpty?: boolean) => Effect.Effect<void, GitError>
}

export class GitClient extends Context.Tag("GitClient")<GitClient, GitClientShape>() {}
