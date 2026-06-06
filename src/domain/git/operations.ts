/**
 * Git operations: clone, push, branch management, and pull request creation.
 */
import path from "path"
import { Effect, Stream, Chunk } from "effect"
import { GitClient } from "../../services/GitClient.ts"
import type { GitIdentity } from "../../services/GitClient.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { GitHubClient } from "../../services/GitHubClient.ts"
import type { CreatePRParams } from "../../services/GitHubClient.ts"
import { GitLabClient } from "../../services/GitLabClient.ts"
import type { CreateMRParams } from "../../services/GitLabClient.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { GitError } from "../../errors/index.ts"
import { gitSpawnEnv } from "./env.ts"
import { gitlabBaseUrlFromRemoteUrl } from "./gitlab-host.ts"

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
// Branch Operations
// ---------------------------------------------------------------------------

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
 * Find untracked entries that are embedded git repositories (a nested `.git`).
 * `git status --porcelain` reports these as a single directory entry with a
 * trailing slash; `git add -A` would stage each as a broken submodule gitlink
 * (mode 160000) pointing at a commit absent from the target repo. We surface
 * the relative paths so staging can exclude them.
 *
 * Best-effort: any failure (status error, fs error) resolves to an empty list
 * so detection never blocks MR/PR creation.
 */
const detectEmbeddedRepos = (repoPath: string) =>
  Effect.gen(function* () {
    const git = yield* GitClient
    const fs = yield* FileSystem
    const entries = yield* git.status(repoPath)
    const dirs = entries
      .filter((e) => e.status === "??" && e.path.endsWith("/"))
      .map((e) => e.path.replace(/\/+$/, ""))
    const embedded: string[] = []
    for (const rel of dirs) {
      if (yield* fs.exists(path.join(repoPath, rel, ".git"))) {
        embedded.push(rel)
      }
    }
    return embedded
  }).pipe(Effect.catchAll(() => Effect.succeed<string[]>([])))

/**
 * Last-resort committer email used when the authenticated account exposes no
 * public email (GitLab users commonly hide it). Keeps the commit attributable to
 * a Runbooks-authored action without fabricating a real-looking address.
 */
const FALLBACK_COMMIT_EMAIL = "runbooks-noreply@gruntwork.io"

/** Build a commit identity from a validated provider user, with safe fallbacks. */
const toCommitIdentity = (user: {
  readonly login: string
  readonly name?: string
  readonly email?: string
}): GitIdentity => ({
  name: user.name?.trim() || user.login || "Runbooks",
  email: user.email?.trim() || FALLBACK_COMMIT_EMAIL,
})

/**
 * Best-effort lookup of the authenticated GitHub user's identity. Used only as a
 * fallback for the commit step when the machine has no git identity configured;
 * never blocks PR creation. Any failure (network, invalid token) resolves to
 * undefined, and the commit proceeds with whatever identity git already has.
 */
const resolveGitHubAuthor = (token: string) =>
  Effect.gen(function* () {
    const gh = yield* GitHubClient
    const validation = yield* gh.validateToken(token)
    return toCommitIdentity(validation.user)
  }).pipe(Effect.catchAll(() => Effect.succeed<GitIdentity | undefined>(undefined)))

/** GitLab equivalent of {@link resolveGitHubAuthor}; validates against the instance. */
const resolveGitLabAuthor = (token: string, baseUrl: string) =>
  Effect.gen(function* () {
    const gl = yield* GitLabClient
    const validation = yield* gl.validateToken(token, baseUrl)
    return toCommitIdentity(validation.user)
  }).pipe(Effect.catchAll(() => Effect.succeed<GitIdentity | undefined>(undefined)))

/**
 * Shared local-git half of opening a PR/MR: create + switch to the head branch,
 * stage all changes, commit, and push to origin. Provider-neutral — the push
 * authenticates with whatever host token the caller resolved (GitHub or GitLab;
 * the clone flow's oauth2 handling makes the push itself host-agnostic).
 *
 * `author` is the authenticated user's identity, applied to the commit only as a
 * fallback when the machine has no git identity configured (see CommitOptions).
 */
const runGitSteps = (
  token: string,
  params: CreatePullRequestParams,
  author: GitIdentity | undefined,
  onProgress?: (line: string) => void,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    const report = (line: string) => Effect.sync(() => onProgress?.(line))

    // Create and switch to the head branch
    yield* report(`Creating branch ${params.headBranch}…`)
    yield* gitClient.createBranch(params.repoPath, params.headBranch)

    // Keep embedded git repos out of the commit: `git add -A` would otherwise
    // stage them as broken submodule gitlinks pointing at commits the target
    // repo can't resolve. Detection is best-effort and never blocks creation.
    const embedded = yield* detectEmbeddedRepos(params.repoPath)
    if (embedded.length > 0) {
      yield* report(
        `Skipping ${embedded.length} embedded git ${
          embedded.length === 1 ? "repository" : "repositories"
        } (cloned into the workspace; not committed as submodules): ${embedded.join(
          ", ",
        )}`,
      )
    }

    // Stage all changes and commit
    yield* report("Staging and committing changes…")
    yield* gitClient.stageAll(params.repoPath, embedded)
    yield* gitClient.commit(params.repoPath, params.commitMessage, { author })

    // Push the branch to origin
    yield* report(`Pushing ${params.headBranch} to origin…`)
    yield* gitClient.push(params.repoPath, "origin", params.headBranch, {
      token,
      setUpstream: true,
    })
  })

/**
 * Create a pull request by orchestrating: the shared git steps (branch, stage,
 * commit, push), then create the PR via the GitHub API and optionally add
 * labels.
 */
export const createPullRequest = (
  token: string,
  params: CreatePullRequestParams,
  /**
   * Optional progress sink, invoked as each step actually starts. Lets callers
   * stream accurate progress (e.g. to the renderer) instead of guessing the
   * sequence up front.
   */
  onProgress?: (line: string) => void,
) =>
  Effect.gen(function* () {
    // Resolve the authenticated user's identity up front so the commit can be
    // attributed to them when the machine has no git identity configured.
    const author = yield* resolveGitHubAuthor(token)
    yield* runGitSteps(token, params, author, onProgress)

    const ghClient = yield* GitHubClient
    const report = (line: string) => Effect.sync(() => onProgress?.(line))

    // Create the PR via GitHub API
    yield* report("Opening pull request…")
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

/**
 * Create a merge request by orchestrating: the shared git steps (branch, stage,
 * commit, push), then create the MR via the GitLab API. Unlike GitHub, labels
 * are set inline on create (no separate add-labels call).
 */
export const createMergeRequest = (
  token: string,
  params: CreatePullRequestParams,
  onProgress?: (line: string) => void,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    const glClient = yield* GitLabClient
    const report = (line: string) => Effect.sync(() => onProgress?.(line))

    // Target the MR at the repo's own GitLab instance (self-hosted or
    // gitlab.com), derived from its remote rather than assumed to be gitlab.com.
    // Best-effort: if the remote can't be read, the client falls back to
    // gitlab.com. Resolved before the git steps so the commit's fallback author
    // is validated against the same instance the token belongs to.
    const remoteUrl = yield* gitClient
      .getRemoteUrl(params.repoPath)
      .pipe(Effect.orElseSucceed(() => ""))
    const baseUrl = gitlabBaseUrlFromRemoteUrl(remoteUrl)

    // Resolve the authenticated user's identity so the commit can be attributed
    // to them when the machine has no git identity configured.
    const author = yield* resolveGitLabAuthor(token, baseUrl)
    yield* runGitSteps(token, params, author, onProgress)

    // Create the MR via GitLab API (labels applied inline)
    yield* report("Opening merge request…")
    const mrParams: CreateMRParams = {
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      body: params.body,
      baseBranch: params.baseBranch,
      headBranch: params.headBranch,
      labels: params.labels,
      baseUrl,
    }

    return yield* glClient.createMergeRequest(token, mrParams)
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
    const proc = yield* spawner.spawn("git", ["ls-files"], { cwd: dir, env: gitSpawnEnv() })
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
 * Parse owner and repo from a git remote URL.
 * Supports both HTTPS and SSH formats:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   git@github.com:owner/repo
 *
 * The last path segment is treated as the repo (project) and everything
 * before it as the owner. This keeps GitHub URLs (always `owner/repo`)
 * unchanged while correctly handling GitLab nested groups, where the owner
 * is the full group path:
 *   https://gitlab.com/group/subgroup/project.git → owner "group/subgroup",
 *                                                    repo  "project"
 */
export const parseOwnerRepoFromURL = (rawURL: string): OwnerRepo | undefined => {
  // Extract the path portion (everything after the host) for both forms.
  //   SSH:   git@host:group/.../repo.git → path is the part after the colon
  //   HTTPS: https://host/group/.../repo → path is the URL pathname
  let path: string
  const sshMatch = rawURL.match(/^git@[^:]+:(.+)$/)
  if (sshMatch) {
    path = sshMatch[1]
  } else {
    try {
      path = new URL(rawURL).pathname
    } catch {
      // Not a valid URL
      return undefined
    }
  }

  const parts = path.split("/").filter(Boolean)
  if (parts.length < 2) {
    return undefined
  }

  const repo = parts[parts.length - 1].replace(/\.git$/, "")
  const owner = parts.slice(0, -1).join("/")
  return { owner, repo }
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
