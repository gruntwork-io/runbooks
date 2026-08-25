/**
 * Inspecting an existing local checkout of a git repository.
 *
 * The `<GitClone>` block can either clone a repo or point at a checkout the
 * user already has on disk. This module covers the second case: resolve the
 * directory the user picked, confirm it really is a git work tree, and gather
 * the same metadata a fresh clone would produce (repo root, remote, ref, file
 * count) so downstream blocks — the workspace file tree, `<GitPullRequest>`,
 * `<DirPicker>` — behave identically either way.
 */
import path from "path"
import { Effect, Stream, Chunk } from "effect"
import { GitClient } from "../../services/GitClient.ts"
import type { GitInfo } from "../../services/GitClient.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { GitError } from "../../errors/index.ts"
import { gitSpawnEnv } from "./env.ts"
import { countFiles, parseOwnerRepoFromURL } from "./operations.ts"

/** Metadata describing a local checkout selected by the user. */
export interface LocalRepoInfo {
  /** Absolute path of the repository root (not the directory the user picked, if it was a subdirectory). */
  readonly absolutePath: string
  /** Path relative to the session working directory; absolute when the repo lives outside it. */
  readonly relativePath: string
  /** Number of tracked files (`git ls-files`). */
  readonly fileCount: number
  /** `origin` remote URL, when the repo has one. */
  readonly remoteUrl?: string
  /** Currently checked out branch/tag, or "HEAD" when detached. */
  readonly branch: string
  readonly refType: GitInfo["refType"]
  readonly commitSha?: string
  /**
   * False when the repo has no commits yet (unborn HEAD). Such a repo has no
   * branch to open a pull request against, so blocks that need a base ref have
   * to seed one before they can do anything useful.
   */
  readonly hasCommits: boolean
  /** Owner/repo parsed from the remote URL, when parseable. */
  readonly owner?: string
  readonly repo?: string
}

/**
 * Resolve a user-supplied checkout directory. Relative paths resolve against
 * the session working directory, matching how `resolveClonePaths` treats a
 * relative `localPath`.
 */
export const resolveLocalRepoPath = (dir: string, workingDir: string): string =>
  path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(workingDir, dir)

/**
 * Resolve, validate, and describe a local checkout.
 *
 * Fails with a GitError carrying a user-facing `stderr` when the directory is
 * missing, is not a directory, or is not inside a git work tree.
 */
export const inspectLocalRepo = (
  dir: string,
  workingDir: string,
): Effect.Effect<
  LocalRepoInfo,
  GitError,
  GitClient | FileSystem | ProcessSpawner
> =>
  Effect.gen(function* () {
    const trimmed = dir.trim()
    if (!trimmed) {
      return yield* Effect.fail(
        new GitError({
          command: "git rev-parse --show-toplevel",
          stderr: "No repository directory selected.",
          exitCode: 1,
        }),
      )
    }

    const selected = resolveLocalRepoPath(trimmed, workingDir)
    const fs = yield* FileSystem

    const stat = yield* fs.stat(selected).pipe(
      Effect.catchAll(() =>
        Effect.fail(
          new GitError({
            command: "stat",
            stderr: `Directory not found: ${selected}`,
            exitCode: 1,
          }),
        ),
      ),
    )
    if (!stat.isDirectory) {
      return yield* Effect.fail(
        new GitError({
          command: "stat",
          stderr: `Not a directory: ${selected}`,
          exitCode: 1,
        }),
      )
    }

    // Resolve the work tree root, so picking a subdirectory of a checkout
    // still registers the repository itself.
    const git = yield* GitClient
    const root = yield* git.getRepoRoot(selected).pipe(
      Effect.catchAll(() =>
        Effect.fail(
          new GitError({
            command: "git rev-parse --show-toplevel",
            stderr: `Not a git repository: ${selected}`,
            exitCode: 1,
          }),
        ),
      ),
    )
    const absolutePath = root ? path.resolve(root) : selected

    // A repo with no commits yet has no HEAD to describe — treat the whole
    // lookup as best-effort so an empty checkout is still selectable.
    const info = yield* git.getInfo(absolutePath).pipe(
      Effect.catchAll(() =>
        Effect.succeed({ branch: "", refType: "branch" } as GitInfo),
      ),
    )

    // getInfo only knows about `origin`. A checkout can legitimately name its
    // remote something else — a fork whose upstream is the interesting one, or
    // a repo re-pointed after `git init` — and without a remote there is no
    // repo_owner/repo_name (nor the GitHub ids derived from them) for
    // downstream blocks to consume. Fall back to whatever remote does exist.
    const remoteUrl = info.remoteUrl ?? (yield* firstRemoteUrl(absolutePath))

    const fileCount = yield* countFiles(absolutePath)
    const parsed = remoteUrl ? parseOwnerRepoFromURL(remoteUrl) : undefined
    // Distinguishes "empty repo" from "getInfo failed for some other reason":
    // both leave `branch` empty above, but only the former is recoverable by
    // seeding a first commit.
    // orElseSucceed keeps this best-effort, like the getInfo lookup above: a
    // repo we can't query is treated as having history, so an unreadable git
    // never gets mistaken for an empty one and offered a seeded branch.
    const hasCommits = yield* git
      .hasCommits(absolutePath)
      .pipe(Effect.orElseSucceed(() => true))

    return {
      absolutePath,
      relativePath: relativeToWorkingDir(absolutePath, workingDir),
      fileCount,
      remoteUrl,
      branch: info.branch,
      refType: info.refType,
      commitSha: info.commitSha,
      hasCommits,
      owner: parsed?.owner,
      repo: parsed?.repo,
    } satisfies LocalRepoInfo
  })

/**
 * URL of the first remote the repo has, or undefined when it has none. Only
 * consulted after `origin` comes up empty, so remote order decides nothing in
 * the common case. Best-effort: a repo we can't read remotes from is still a
 * usable checkout, it just yields no owner/repo.
 */
const firstRemoteUrl = (repoPath: string) =>
  Effect.gen(function* () {
    const names = yield* readGitLines(repoPath, ["remote"])
    if (names.length === 0) return undefined
    const urls = yield* readGitLines(repoPath, ["remote", "get-url", names[0]])
    return urls[0]
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

/**
 * Run a short git query and return its stdout lines, or none if it failed.
 *
 * `Effect.ensuring` kills the child if this effect is interrupted mid-flight.
 * On the normal path the process has already exited and the signal is a no-op,
 * so this costs nothing and leaves no orphan behind if a caller ever gains a
 * cancellation path.
 */
const readGitLines = (repoPath: string, args: string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const proc = yield* spawner.spawn("git", args, { cwd: repoPath, env: gitSpawnEnv() })

    return yield* Effect.gen(function* () {
      const lines = Chunk.toArray(yield* Stream.runCollect(proc.output))
        .filter((l) => l.source === "stdout")
        .map((l) => l.line.trim())
        .filter(Boolean)
      return (yield* proc.exitCode) === 0 ? lines : []
    }).pipe(Effect.ensuring(proc.kill.pipe(Effect.ignore)))
  })

/**
 * Display path for a checkout: relative to the working directory when it lives
 * inside it, absolute otherwise. A local checkout is usually somewhere else
 * entirely, and `../../../dev/repo` reads worse than the absolute path.
 */
function relativeToWorkingDir(absolutePath: string, workingDir: string): string {
  const relative = path.relative(workingDir, absolutePath)
  if (!relative) return "."
  if (relative.startsWith("..") || path.isAbsolute(relative)) return absolutePath
  return relative
}
