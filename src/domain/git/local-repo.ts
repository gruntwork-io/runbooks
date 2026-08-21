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
import { Effect } from "effect"
import { GitClient } from "../../services/GitClient.ts"
import type { GitInfo } from "../../services/GitClient.ts"
import { FileSystem } from "../../services/FileSystem.ts"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { GitError } from "../../errors/index.ts"
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

    const fileCount = yield* countFiles(absolutePath)
    const parsed = info.remoteUrl ? parseOwnerRepoFromURL(info.remoteUrl) : undefined

    return {
      absolutePath,
      relativePath: relativeToWorkingDir(absolutePath, workingDir),
      fileCount,
      remoteUrl: info.remoteUrl,
      branch: info.branch,
      refType: info.refType,
      commitSha: info.commitSha,
      owner: parsed?.owner,
      repo: parsed?.repo,
    } satisfies LocalRepoInfo
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
