/**
 * Live implementation of the GitClient service using ProcessSpawner.
 *
 * This layer depends on ProcessSpawner, so it uses Layer.effect to pull
 * the spawner from context.
 */
import * as path from "node:path"
import { Effect, Layer, Stream, Chunk } from "effect"
import { GitClient } from "../services/GitClient.ts"
import type {
  GitClientShape,
  CloneOptions,
  CloneProgress,
  CloneResult,
  PushOptions,
  DiffEntry,
  StatusEntry,
  GitInfo,
} from "../services/GitClient.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { GitError } from "../errors/index.ts"
import { injectTokenIntoUrl } from "../domain/git/url.ts"

/**
 * Run a git command, collect all output, and return stdout lines.
 * Fails with GitError if the exit code is non-zero.
 */
function runGit(
  spawner: ProcessSpawner["Type"],
  args: string[],
  cwd: string,
  stdin?: string,
) {
  return Effect.gen(function* () {
    const proc = yield* spawner.spawn("git", args, { cwd, stdin })
    const chunks = yield* Stream.runCollect(proc.output)
    const lines = Chunk.toArray(chunks)
    const code = yield* proc.exitCode

    if (code !== 0) {
      const stderr = lines
        .filter((l) => l.source === "stderr")
        .map((l) => l.line)
        .join("\n")
      return yield* Effect.fail(
        new GitError({
          command: `git ${args.join(" ")}`,
          stderr,
          exitCode: code,
        }),
      )
    }

    return lines.filter((l) => l.source === "stdout").map((l) => l.line)
  })
}

function makeGitClient(spawner: ProcessSpawner["Type"]): GitClientShape {
  return {
    clone: (url: string, dest: string, options?: CloneOptions) => {
      const args = ["clone", "--progress"]
      const effectiveUrl = options?.token ? injectTokenIntoUrl(url, options.token) : url

      if (options?.ref) {
        args.push("--branch", options.ref)
      }

      args.push(effectiveUrl, dest)

      return Stream.unwrap(
        Effect.gen(function* () {
          const proc = yield* spawner.spawn("git", args, {
            cwd: options?.repoPath,
          })

          return Stream.map(proc.output, (outputLine): CloneProgress => ({
            line: outputLine.line,
            timestamp: new Date().toISOString(),
          }))
        }),
      )
    },

    cloneSimple: (url: string, dest: string, options?: CloneOptions) =>
      Effect.gen(function* () {
        const effectiveUrl = options?.token ? injectTokenIntoUrl(url, options.token) : url

        if (options?.sparse) {
          // Sparse checkout: blobless clone without checkout, then sparse-checkout the subpath
          const cloneArgs = ["clone", "--filter=blob:none", "--no-checkout", "--progress"]
          if (options.ref) {
            cloneArgs.push("--branch", options.ref)
          }
          cloneArgs.push(effectiveUrl, dest)
          yield* runGit(spawner, cloneArgs, options?.repoPath ?? ".")

          yield* runGit(spawner, ["sparse-checkout", "init", "--cone"], dest)
          yield* runGit(spawner, ["sparse-checkout", "set", options.sparse], dest)
          yield* runGit(spawner, ["checkout"], dest)
        } else {
          // Standard full clone
          const args = ["clone", "--progress"]
          if (options?.ref) {
            args.push("--branch", options.ref)
          }
          args.push(effectiveUrl, dest)

          const proc = yield* spawner.spawn("git", args, {
            cwd: options?.repoPath,
          })
          const chunks = yield* Stream.runCollect(proc.output)
          const code = yield* proc.exitCode

          if (code !== 0) {
            const lines = Chunk.toArray(chunks)
            const stderr = lines
              .filter((l) => l.source === "stderr")
              .map((l) => l.line)
              .join("\n")
            return yield* Effect.fail(
              new GitError({ command: `git clone`, stderr, exitCode: code }),
            )
          }
        }

        // Count files in the destination
        const lsProc = yield* spawner.spawn("find", [".", "-type", "f"], { cwd: dest })
        const lsChunks = yield* Stream.runCollect(lsProc.output)
        const fileCount = Chunk.toArray(lsChunks).filter((l) => l.source === "stdout").length
        const absolutePath = path.resolve(dest)

        return {
          fileCount,
          absolutePath,
          relativePath: dest,
        } satisfies CloneResult
      }),

    push: (repoPath: string, remote: string, branch: string, options?: PushOptions) =>
      Effect.gen(function* () {
        const args = ["push"]
        if (options?.setUpstream) {
          args.push("-u")
        }
        args.push(remote, branch)

        // If a token is provided, temporarily set the remote URL with credentials
        if (options?.token) {
          const urlLines = yield* runGit(spawner, ["remote", "get-url", remote], repoPath)
          const originalUrl = urlLines[0] ?? ""
          const authedUrl = injectTokenIntoUrl(originalUrl, options.token)
          yield* runGit(spawner, ["remote", "set-url", remote, authedUrl], repoPath)
          yield* runGit(spawner, args, repoPath).pipe(
            Effect.ensuring(
              runGit(spawner, ["remote", "set-url", remote, originalUrl], repoPath).pipe(
                Effect.catchAll(() => Effect.void),
              ),
            ),
          )
          return undefined as void
        }

        yield* runGit(spawner, args, repoPath)
      }),

    deleteBranch: (repoPath: string, branch: string) =>
      Effect.gen(function* () {
        yield* runGit(spawner, ["branch", "-d", branch], repoPath)
      }),

    getCurrentBranch: (repoPath: string) =>
      Effect.gen(function* () {
        const lines = yield* runGit(spawner, ["rev-parse", "--abbrev-ref", "HEAD"], repoPath)
        return lines[0] ?? ""
      }),

    getRemoteUrl: (repoPath: string) =>
      Effect.gen(function* () {
        const lines = yield* runGit(spawner, ["remote", "get-url", "origin"], repoPath)
        return lines[0] ?? ""
      }),

    getInfo: (repoPath: string) =>
      Effect.gen(function* () {
        const branchLines = yield* runGit(spawner, ["rev-parse", "--abbrev-ref", "HEAD"], repoPath)
        const branch = branchLines[0] ?? ""

        // Determine ref type
        let refType: GitInfo["refType"] = "branch"
        if (branch === "HEAD") {
          refType = "detached"
        } else {
          // Check if it's a tag
          const tagResult = yield* runGit(spawner, ["describe", "--tags", "--exact-match", "HEAD"], repoPath).pipe(
            Effect.catchAll(() => Effect.succeed([] as string[])),
          )
          if (tagResult.length > 0) {
            refType = "tag"
          }
        }

        // Get remote URL
        const remoteUrl = yield* runGit(spawner, ["remote", "get-url", "origin"], repoPath).pipe(
          Effect.map((lines) => lines[0]),
          Effect.catchAll(() => Effect.succeed(undefined)),
        )

        // Get commit SHA
        const shaLines = yield* runGit(spawner, ["rev-parse", "HEAD"], repoPath).pipe(
          Effect.catchAll(() => Effect.succeed([] as string[])),
        )
        const commitSha = shaLines[0]

        return { branch, refType, remoteUrl, commitSha } satisfies GitInfo
      }),

    diff: (repoPath: string, filePath?: string) =>
      Effect.gen(function* () {
        // Get numstat
        const numstatArgs = ["diff", "--numstat"]
        if (filePath) numstatArgs.push("--", filePath)
        const numstatLines = yield* runGit(spawner, numstatArgs, repoPath)

        const entries: DiffEntry[] = []
        for (const line of numstatLines) {
          if (!line.trim()) continue
          const parts = line.split("\t")
          if (parts.length < 3) continue

          const [addStr, delStr, diffPath] = parts
          const isBinary = addStr === "-" && delStr === "-"

          // Get content diff for this file
          let originalContent: string | undefined
          let newContent: string | undefined
          let diffTruncated = false

          if (!isBinary) {
            const contentArgs = ["diff", "--", diffPath]
            const contentLines = yield* runGit(spawner, contentArgs, repoPath).pipe(
              Effect.catchAll(() => Effect.succeed([] as string[])),
            )
            const diffContent = contentLines.join("\n")
            if (diffContent.length > 100_000) {
              diffTruncated = true
            }
            // Store the raw diff as newContent for now
            newContent = diffTruncated ? diffContent.slice(0, 100_000) : diffContent
          }

          entries.push({
            path: diffPath,
            changeType: "modified",
            additions: isBinary ? 0 : parseInt(addStr, 10),
            deletions: isBinary ? 0 : parseInt(delStr, 10),
            originalContent,
            newContent,
            isBinary,
            diffTruncated,
          })
        }

        return entries
      }),

    status: (repoPath: string) =>
      Effect.gen(function* () {
        const lines = yield* runGit(spawner, ["status", "--porcelain", "--untracked-files=all"], repoPath)
        return lines
          .filter((l) => l.trim().length > 0)
          .map((line): StatusEntry => ({
            path: line.slice(3),
            status: line.slice(0, 2).trim(),
          }))
      }),

    hasCommits: (repoPath: string) =>
      runGit(spawner, ["rev-parse", "HEAD"], repoPath).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      ),

    hasChanges: (repoPath: string) =>
      Effect.gen(function* () {
        const lines = yield* runGit(spawner, ["status", "--porcelain", "--untracked-files=all"], repoPath)
        return lines.some((l) => l.trim().length > 0)
      }),

    checkIgnored: (repoPath: string, paths: string[]) =>
      Effect.gen(function* () {
        if (paths.length === 0) return new Set<string>()
        const stdin = paths.join("\n")
        // git check-ignore exits with 1 when no paths are ignored, so handle that
        const proc = yield* spawner.spawn("git", ["check-ignore", "--stdin"], {
          cwd: repoPath,
          stdin,
        })
        const chunks = yield* Stream.runCollect(proc.output)
        // Ignore exit code — 1 just means "no ignored files found"
        const lines = Chunk.toArray(chunks)
          .filter((l) => l.source === "stdout")
          .map((l) => l.line.trim())
          .filter((l) => l.length > 0)
        return new Set(lines)
      }),

    createBranch: (repoPath: string, branch: string) =>
      Effect.gen(function* () {
        yield* runGit(spawner, ["checkout", "-b", branch], repoPath)
      }),

    stageAll: (repoPath: string) =>
      Effect.gen(function* () {
        yield* runGit(spawner, ["add", "-A"], repoPath)
      }),

    commit: (repoPath: string, message: string, allowEmpty?: boolean) =>
      Effect.gen(function* () {
        const args = ["commit", "-m", message]
        if (allowEmpty) {
          args.push("--allow-empty")
        }
        yield* runGit(spawner, args, repoPath)
      }),
  }
}

export const GitCliClientLive = Layer.effect(
  GitClient,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    return makeGitClient(spawner)
  }),
)
