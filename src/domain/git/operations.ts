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
import { gitCredentialUsername } from "./url.ts"
import { gitRemoteOwnerRepo, parseGitRemoteUrl } from "./remote-url.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Branches that cannot be deleted via deleteBranch, nor used as the head branch
 * of a PR/MR (see runGitSteps).
 */
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
  /**
   * GitHub host whose API opens the PR (github.com, a GHES host, or a
   * `<sub>.ghe.com` tenant) — the repo's origin host, which the caller has
   * already checked the token belongs to. Defaults to github.com. Unused for
   * GitLab merge requests, which derive their instance from the remote.
   */
  readonly host?: string
}

export interface SeedDefaultBranchParams {
  readonly repoPath: string
  /** Branch to create and push as the repo's first ref. */
  readonly branch: string
  readonly provider: "github" | "gitlab"
  /** GitHub host the token belongs to (see CreatePullRequestParams.host). */
  readonly host?: string
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
 * develop, dev, staging, release, prod, production) and the branch that is
 * currently checked out. The delete itself is `git branch -d`, so a branch with
 * commits not merged into its upstream (or HEAD) is refused, not discarded.
 */
export const deleteBranch = (repoPath: string, branch: string) =>
  Effect.gen(function* () {
    if (PROTECTED_BRANCHES.has(branch)) {
      return yield* new GitError({
        command: "branch -d",
        stderr: `Refusing to delete protected branch: ${branch}`,
        exitCode: 1,
      })
    }

    const gitClient = yield* GitClient

    // git's own refusal ("used by worktree at …") doesn't say what to do.
    // Best-effort: if HEAD can't be read, let `git branch -d` decide.
    const current = yield* gitClient
      .getCurrentBranch(repoPath)
      .pipe(Effect.orElseSucceed(() => ""))
    if (current === branch) {
      return yield* new GitError({
        command: "branch -d",
        stderr: `Cannot delete branch ${branch} because it is currently checked out`,
        exitCode: 1,
      })
    }

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
const resolveGitHubAuthor = (token: string, host?: string) =>
  Effect.gen(function* () {
    const gh = yield* GitHubClient
    const validation = yield* gh.validateToken(token, host)
    return toCommitIdentity(validation.user)
  }).pipe(Effect.catchAll(() => Effect.succeed<GitIdentity | undefined>(undefined)))

/**
 * The GitLab instance (API origin) of a repo whose `origin` remote is
 * `remoteUrl` ("" when it has none). Fails with a GitError when there is no
 * origin, or origin names no host (see gitlabBaseUrlFromRemoteUrl), so the
 * caller stops before its token goes anywhere: guessing gitlab.com would hand
 * a self-hosted instance's token to gitlab.com.
 */
export const gitlabInstanceForRemoteUrl = (remoteUrl: string, purpose: string) => {
  const baseUrl = gitlabBaseUrlFromRemoteUrl(remoteUrl)
  if (baseUrl) return Effect.succeed(baseUrl)
  // The remote itself stays out of the message: one that doesn't parse
  // may still carry credentials stripUrlCredentials couldn't find.
  return Effect.fail(
    new GitError({
      command: "resolve gitlab instance",
      stderr: remoteUrl
        ? "Couldn't tell which GitLab instance this repository's origin remote is on, so the GitLab " +
          "token was not sent anywhere. Point origin at the project on your GitLab instance (an " +
          `https:// URL or git@<host>:<group>/<project>.git) before ${purpose}.`
        : "This repository has no origin remote, so there is no GitLab instance to send the GitLab " +
          `token to. Add an origin that points at the project on your GitLab instance before ${purpose}.`,
      exitCode: 1,
    }),
  )
}

/** gitlabInstanceForRemoteUrl for the repo at `repoPath`, reading its `origin` remote. */
const gitlabInstanceForRepo = (repoPath: string, purpose: string) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    const remoteUrl = yield* gitClient.getRemoteUrl(repoPath).pipe(Effect.orElseSucceed(() => ""))
    return yield* gitlabInstanceForRemoteUrl(remoteUrl, purpose)
  })

/** GitLab equivalent of {@link resolveGitHubAuthor}; validates against the instance. */
const resolveGitLabAuthor = (token: string, baseUrl: string) =>
  Effect.gen(function* () {
    const gl = yield* GitLabClient
    const validation = yield* gl.validateToken(token, baseUrl)
    return toCommitIdentity(validation.user)
  }).pipe(Effect.catchAll(() => Effect.succeed<GitIdentity | undefined>(undefined)))

/** Wrap an optional progress callback as an Effect-returning reporter. */
const makeReport =
  (onProgress?: (line: string) => void) =>
  (line: string) =>
    Effect.sync(() => onProgress?.(line))

/**
 * Shared local-git half of opening a PR/MR: create + switch to the head branch,
 * stage all changes, commit, and push to origin. The push authenticates with
 * the token the caller resolved, sent with `provider`'s credential username
 * (`oauth2` for GitLab, `x-access-token` for GitHub; see gitCredentialUsername).
 *
 * `author` is the authenticated user's identity, applied to the commit only as a
 * fallback when the machine has no git identity configured (see CommitOptions).
 *
 * Resumable: an attempt that fails after `checkout -b` (a failed push, a failed
 * API call) leaves HEAD on the head branch. Running again with the same branch
 * name picks up there instead of failing on "a branch named … already exists":
 * it skips the branch creation, commits only if there is something new, and
 * pushes. A resumed branch with no commits of its own (the first attempt
 * stopped at "nothing to commit") is still pushed, and the provider then
 * rejects the PR/MR as having no changes; the pushed branch is reused by the
 * next attempt.
 */
const runGitSteps = (
  token: string,
  provider: "github" | "gitlab",
  params: CreatePullRequestParams,
  author: GitIdentity | undefined,
  onProgress?: (line: string) => void,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    const report = makeReport(onProgress)

    // Resuming skips `checkout -b`, whose failure on an existing branch was
    // the only thing stopping a commit and push straight to the base branch.
    if (params.headBranch === params.baseBranch || PROTECTED_BRANCHES.has(params.headBranch)) {
      const reason =
        params.headBranch === params.baseBranch ? "it is the base branch" : "it is a protected branch"
      return yield* new GitError({
        command: "checkout -b",
        stderr: `Refusing to commit to ${params.headBranch}: ${reason}. Choose a new branch name for the changes.`,
        exitCode: 1,
      })
    }

    // Best-effort: an unreadable HEAD (e.g. an empty repo) just means "not
    // resuming", and `checkout -b` reports whatever is actually wrong.
    const current = yield* gitClient
      .getCurrentBranch(params.repoPath)
      .pipe(Effect.orElseSucceed(() => ""))
    const resuming = current === params.headBranch

    if (resuming) {
      yield* report(`Resuming on existing branch ${params.headBranch}…`)
    } else {
      yield* report(`Creating branch ${params.headBranch}…`)
      yield* gitClient.createBranch(params.repoPath, params.headBranch)
    }

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

    yield* report("Staging and committing changes…")
    yield* gitClient.stageAll(params.repoPath, embedded)

    // On a fresh branch "nothing to commit" is the clearest error, so always
    // commit. On a resumed branch an earlier attempt may already have committed
    // everything; commit only what is staged now. (Not hasChanges: the embedded
    // repos left out of staging still show as untracked.) status() trims the XY
    // code, so a worktree-only change (a tracked submodule with modified
    // content) also counts here, and the commit then fails as on a fresh branch.
    const hasStaged = resuming
      ? (yield* gitClient.status(params.repoPath)).some((e) => e.status !== "??")
      : true
    if (hasStaged) {
      yield* gitClient.commit(params.repoPath, params.commitMessage, { author })
    } else {
      yield* report("No new changes to commit; pushing the existing commits…")
    }

    yield* report(`Pushing ${params.headBranch} to origin…`)
    yield* gitClient.push(params.repoPath, "origin", params.headBranch, {
      token,
      username: gitCredentialUsername(provider),
      setUpstream: true,
    })
  })

/**
 * Create a pull request by orchestrating: the shared git steps (branch, stage,
 * commit, push), then create the PR via the GitHub API and optionally add
 * labels. Labels are best-effort: once the PR exists, a labeling failure is
 * reported as a progress warning and the PR is still returned.
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
    const author = yield* resolveGitHubAuthor(token, params.host)
    yield* runGitSteps(token, "github", params, author, onProgress)

    const ghClient = yield* GitHubClient
    const report = makeReport(onProgress)

    yield* report("Opening pull request…")
    const prParams: CreatePRParams = {
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      body: params.body,
      baseBranch: params.baseBranch,
      headBranch: params.headBranch,
    }

    const pr = yield* ghClient.createPullRequest(token, prParams, params.host)

    if (params.labels && params.labels.length > 0) {
      yield* report("Adding labels…")
      yield* ghClient
        .addLabels(token, params.owner, params.repo, pr.number, params.labels, params.host)
        .pipe(
          Effect.catchAll((e) =>
            report(
              `Warning: PR #${pr.number} was created but labels could not be applied: ${
                e.message || `status ${e.status}`
              }`,
            ),
          ),
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
    const glClient = yield* GitLabClient
    const report = makeReport(onProgress)

    // Target the MR at the repo's own GitLab instance (self-hosted or
    // gitlab.com), derived from its remote rather than assumed to be gitlab.com;
    // with no instance to read, stop here. Resolved before the git steps so the
    // commit's fallback author is validated against the same instance the token
    // belongs to.
    const baseUrl = yield* gitlabInstanceForRepo(params.repoPath, "creating a merge request")

    // Resolve the authenticated user's identity so the commit can be attributed
    // to them when the machine has no git identity configured.
    const author = yield* resolveGitLabAuthor(token, baseUrl)
    yield* runGitSteps(token, "gitlab", params, author, onProgress)

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

/**
 * Message for the commit that seeds an empty repository. Matches what GitHub
 * and GitLab call the equivalent commit when they initialize a repo for you.
 */
const INITIAL_COMMIT_MESSAGE = "Initial commit"

/**
 * Give a repository that has no commits its first branch.
 *
 * A freshly created remote has no refs at all, so there is nothing for a pull
 * request to target: the API rejects the base branch as `invalid`, and it does
 * so at the very end, after the work has already been committed and pushed.
 * Seeding the default branch up front creates that target.
 *
 * The commit is deliberately empty. It exists so the default branch has
 * something to point at, which means the branch a runbook pushes later shares
 * an ancestor with it and opens as a reviewable diff instead of an unrelated
 * root commit.
 */
export const seedDefaultBranch = (
  token: string,
  params: SeedDefaultBranchParams,
  onProgress?: (line: string) => void,
) =>
  Effect.gen(function* () {
    const gitClient = yield* GitClient
    const report = makeReport(onProgress)

    // This exists purely to rescue the empty case. A repo with history already
    // has a branch to target, and manufacturing commits in one is never right.
    if (yield* gitClient.hasCommits(params.repoPath)) {
      return yield* Effect.fail(
        new GitError({
          command: "git commit --allow-empty",
          stderr: "Repository already has commits, so it needs no initial branch.",
          exitCode: 1,
        }),
      )
    }

    // Same fallback-author treatment as the PR/MR flows: only used when the
    // machine has no git identity of its own configured. A GitLab token is
    // validated only at the instance origin names; with none, nothing runs.
    const author = yield* (params.provider === "gitlab"
      ? Effect.flatMap(
          gitlabInstanceForRepo(params.repoPath, "creating the default branch"),
          (baseUrl) => resolveGitLabAuthor(token, baseUrl),
        )
      : resolveGitHubAuthor(token, params.host))

    yield* report(`Creating branch ${params.branch}…`)
    yield* gitClient.createBranch(params.repoPath, params.branch)

    // `git commit` without `-a` only commits the index, and an empty clone's
    // index is empty — so files a runbook may already have written into the
    // work tree stay untracked rather than landing in this commit.
    yield* report("Creating an empty initial commit…")
    yield* gitClient.commit(params.repoPath, INITIAL_COMMIT_MESSAGE, {
      allowEmpty: true,
      author,
    })

    yield* report(`Pushing ${params.branch} to origin…`)
    yield* gitClient.push(params.repoPath, "origin", params.branch, {
      token,
      username: gitCredentialUsername(params.provider),
      setUpstream: true,
    })

    return { branch: params.branch }
  })

/**
 * Name of the branch an empty repository's HEAD points at before its first
 * commit, or undefined when the repo has one (or git can't say).
 *
 * `rev-parse --abbrev-ref HEAD`, which getInfo and getCurrentBranch use, fails
 * on an unborn HEAD, so ask git for the symbolic name instead. A clone inherits
 * that name from the remote's advertised default branch, which is exactly the
 * branch a pull request will later want to target — better than guessing
 * "main" at a repo whose default is "master".
 */
export const unbornBranchName = (repoPath: string) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const proc = yield* spawner.spawn("git", ["branch", "--show-current"], {
      cwd: repoPath,
      env: gitSpawnEnv(),
    })

    return yield* Effect.gen(function* () {
      const lines = Chunk.toArray(yield* Stream.runCollect(proc.output))
        .filter((l) => l.source === "stdout")
        .map((l) => l.line.trim())
        .filter(Boolean)
      return (yield* proc.exitCode) === 0 ? lines[0] : undefined
    }).pipe(Effect.ensuring(proc.kill.pipe(Effect.ignore)))
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

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
    // Use the explicit localPath, else derive the dir name from the repo URL.
    const dirName = localPath ? localPath : (parseOwnerRepoFromURL(url)?.repo ?? "repo")

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
 * Supports every form parseGitRemoteUrl does, with any SSH user, e.g.:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   git@github.com:owner/repo
 *   git@[::1]:owner/repo.git
 *   gitlab@gitlab.corp.net:group/project.git
 *
 * The last path segment is treated as the repo (project) and everything
 * before it as the owner. This keeps GitHub URLs (always `owner/repo`)
 * unchanged while correctly handling GitLab nested groups, where the owner
 * is the full group path:
 *   https://gitlab.com/group/subgroup/project.git → owner "group/subgroup",
 *                                                    repo  "project"
 */
export const parseOwnerRepoFromURL = (rawURL: string): OwnerRepo | undefined =>
  gitRemoteOwnerRepo(rawURL)

/**
 * Validate whether a string is a git URL the clone handler accepts: an
 * http(s) URL, or the scp-like `user@host:path` form, naming an `owner/repo`
 * path. Any SSH user is accepted, not just `git`: self-managed GitLab can run
 * its SSH server under another name (`gitlab@gitlab.corp.net:group/project.git`).
 * A URL git or ssh could read as an option (leading `-`, including in the
 * user) or whose host is malformed never validates (see parseGitRemoteUrl).
 */
export const isValidGitURL = (url: string): boolean => {
  const remote = parseGitRemoteUrl(url)
  if (!remote) return false
  const allowed = remote.scpLike
    ? remote.user !== undefined
    : remote.scheme === "https" || remote.scheme === "http"
  return allowed && gitRemoteOwnerRepo(url) !== undefined
}
