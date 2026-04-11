/**
 * Git operations — clone, push, branch management, and pull request creation.
 * Port of api/git_clone.go and api/github_pull_request.go.
 */
import path from "path"
import { Effect, Stream, Chunk } from "effect"
import { GitClient } from "../../services/GitClient.ts"
import type {
  CloneOptions,
  PushOptions,
} from "../../services/GitClient.ts"
import { GitHubClient } from "../../services/GitHubClient.ts"
import type { CreatePRParams } from "../../services/GitHubClient.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { GitError } from "../../errors/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Branches that cannot be deleted via deleteBranch. */
const PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "dev",
  "staging",
  "release",
  "prod",
  "production",
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatePullRequestParams {
  readonly owner: string
  readonly repo: string
  readonly title: string
  readonly body?: string
  readonly baseBranch: string
  readonly headBranch: string
  readonly commitMessage: string
  readonly labels?: string[]
  readonly repoPath: string
}

export interface ResolvedClonePaths {
  readonly absolutePath: string
  readonly relativePath: string
}

export interface OwnerRepo {
  readonly owner: string
  readonly repo: string
}

// ---------------------------------------------------------------------------
// Clone Operations
// ---------------------------------------------------------------------------

/**
 * Clone a repository and return a stream of progress events.
 * Delegates to GitClient.clone which produces a Stream of CloneProgress.
 */
export const cloneRepository = (
  url: string,
  dest: string,
  options?: CloneOptions,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    return gitClient.clone(url, dest, options)
  })

/**
 * Clone a repository without streaming progress. Returns the final
 * CloneResult once the clone is complete.
 */
export const cloneSimple = (
  url: string,
  dest: string,
  options?: CloneOptions,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    return yield* gitClient.cloneSimple(url, dest, options)
  })

// ---------------------------------------------------------------------------
// Branch Operations
// ---------------------------------------------------------------------------

/**
 * Push a branch to a remote.
 */
export const pushBranch = (
  repoPath: string,
  remote: string,
  branch: string,
  options?: PushOptions,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    return yield* gitClient.push(repoPath, remote, branch, options)
  })

/**
 * Delete a local branch. Refuses to delete protected branches (main, master,
 * develop, dev, staging, release, prod, production).
 */
export const deleteBranch = (repoPath: string, branch: string) =>
  Effect.gen(function* () {
    if (PROTECTED_BRANCHES.has(branch)) {
      return yield* new GitError({
        command: "branch -D",
        stderr: `Refusing to delete protected branch: ${branch}`,
        exitCode: 1,
      })
    }

    const gitClient = yield* GitClient
    return yield* gitClient.deleteBranch(repoPath, branch)
  })

// ---------------------------------------------------------------------------
// Pull Request Creation
// ---------------------------------------------------------------------------

/**
 * Create a pull request by orchestrating: create branch, stage all changes,
 * commit, push, create PR via GitHub API, and optionally add labels.
 */
export const createPullRequest = (
  token: string,
  params: CreatePullRequestParams,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    const ghClient = yield* GitHubClient

    // Create and switch to the head branch
    yield* gitClient.createBranch(params.repoPath, params.headBranch)

    // Stage all changes
    yield* gitClient.stageAll(params.repoPath)

    // Commit
    yield* gitClient.commit(params.repoPath, params.commitMessage)

    // Push the branch to origin
    yield* gitClient.push(params.repoPath, "origin", params.headBranch, {
      token,
      setUpstream: true,
    })

    // Create the PR via GitHub API
    const prParams: CreatePRParams = {
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      body: params.body,
      baseBranch: params.baseBranch,
      headBranch: params.headBranch,
      labels: params.labels,
    }

    const pr = yield* ghClient.createPullRequest(token, prParams)

    // Add labels if provided
    if (params.labels && params.labels.length > 0) {
      yield* ghClient.addLabels(
        token,
        params.owner,
        params.repo,
        pr.number,
        params.labels,
      )
    }

    return pr
  })

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve absolute and relative clone paths from a local path, URL, and
 * working directory. If localPath is provided it is used directly; otherwise
 * the repository name is extracted from the URL.
 */
export const resolveClonePaths = (
  localPath: string | undefined,
  url: string,
  workingDir: string,
) =>
  Effect.sync(() => {
    let dirName: string

    if (localPath) {
      dirName = localPath
    } else {
      // Extract repo name from URL
      const parsed = parseOwnerRepoFromURL(url)
      if (!parsed) {
        dirName = "repo"
      } else {
        dirName = parsed.repo
      }
    }

    // Build absolute path
    const isAbsolute = path.isAbsolute(dirName)
    const absolutePath = isAbsolute ? path.resolve(dirName) : path.resolve(workingDir, dirName)

    // Compute relative path from working directory
    const relativePath = isAbsolute ? path.relative(workingDir, absolutePath) : dirName

    return { absolutePath, relativePath } as ResolvedClonePaths
  })

// ---------------------------------------------------------------------------
// File Counting
// ---------------------------------------------------------------------------

/**
 * Count tracked files in a git repository using `git ls-files`.
 * Falls back to 0 if the command fails (e.g., not a git repo).
 */
export const countFiles = (dir: string) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const proc = yield* spawner.spawn("git", ["ls-files"], { cwd: dir })
    const chunks = yield* Stream.runCollect(proc.output)
    const lines = Chunk.toArray(chunks)
    const code = yield* proc.exitCode
    if (code !== 0) return 0
    return lines.filter((l) => l.source === "stdout" && l.line.trim() !== "").length
  }).pipe(Effect.catchAll(() => Effect.succeed(0)))

// ---------------------------------------------------------------------------
// URL Parsing
// ---------------------------------------------------------------------------

/**
 * Parse owner and repo from a GitHub URL.
 * Supports both HTTPS and SSH formats:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   git@github.com:owner/repo
 */
export const parseOwnerRepoFromURL = (rawURL: string): OwnerRepo | undefined => {
  // Try SSH format: git@github.com:owner/repo.git
  const sshMatch = rawURL.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }

  // Try HTTPS format
  try {
    const url = new URL(rawURL)
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length >= 2) {
      const repo = parts[1].replace(/\.git$/, "")
      return { owner: parts[0], repo }
    }
  } catch {
    // Not a valid URL
  }

  return undefined
}

/**
 * Validate whether a string is a valid git URL (HTTPS or SSH format).
 */
export const isValidGitURL = (url: string): boolean => {
  // SSH format
  if (/^git@[^:]+:.+\/.+$/.test(url)) {
    return true
  }

  // HTTPS format
  try {
    const parsed = new URL(url)
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.pathname.split("/").filter(Boolean).length >= 2
    )
  } catch {
    return false
  }
}
