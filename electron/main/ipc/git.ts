/**
 * IPC handlers for git operations with streaming progress.
 *
 * Clone and push operations stream progress events to the renderer via
 * event.sender.send(). Pull request creation and branch deletion are
 * simple request-response handlers.
 */
import { Effect, Stream } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import { ProcessSpawner } from "../../../src/services/ProcessSpawner.ts"
import {
  resolveClonePaths,
  countFiles,
  deleteBranch,
  createPullRequest,
  pushBranch,
  isValidGitURL,
  type CreatePullRequestParams,
} from "../../../src/domain/git/operations.ts"
import type { CloneOptions, PushOptions } from "../../../src/services/GitClient.ts"
import { isContainedIn } from "../../../src/path-validation.ts"
import { PathTraversalError, GitError } from "../../../src/errors/index.ts"
import { validateSessionPath } from "./path-guard.ts"

export function registerGitHandlers(): void {
  ipcMain.handle(
    "git:clone",
    async (
      event,
      params: {
        url: string
        localPath?: string
        ref?: string
        credentials?: { token: string }
      },
    ) => {
      return runtime.runPromise(
        Effect.scoped(
        Effect.gen(function* () {
          // Validate the clone URL before any other processing
          if (!isValidGitURL(params.url)) {
            return yield* Effect.fail(
              new GitError({
                command: "git clone",
                stderr: `invalid or disallowed git URL: ${params.url}`,
                exitCode: 1,
              }),
            )
          }

          // Resolve clone destination paths
          const session = yield* sessionManager.getSession()
          const paths = yield* resolveClonePaths(
            params.localPath,
            params.url,
            session.workingDir,
          )

          // Validate clone destination is within the session working dir
          if (!isContainedIn(paths.absolutePath, session.workingDir)) {
            return yield* Effect.fail(
              new PathTraversalError({
                path: paths.absolutePath,
                message: "clone destination is outside session working directory",
              }),
            )
          }

          const options: CloneOptions = {
            ref: params.ref,
            token: params.credentials?.token,
          }

          // Clone the repository using direct process spawning.
          // We avoid the GitClient's stream-based API because
          // Stream.runCollect hangs in Electron's runtime.runPromise.
          const spawner = yield* ProcessSpawner
          const cloneArgs = ["clone", "--progress"]
          if (options.ref) cloneArgs.push("--branch", options.ref)

          const effectiveUrl = options.token
            ? (() => { try { const u = new URL(params.url); u.username = "x-access-token"; u.password = options.token!; return u.toString(); } catch { return params.url; } })()
            : params.url

          cloneArgs.push(effectiveUrl, paths.absolutePath)

          // debugLog("[git:clone] spawning git process...")
          const proc = yield* spawner.spawn("git", cloneArgs, {})

          // debugLog("[git:clone] draining output stream...")
          yield* Stream.runForEach(proc.output, (line) =>
            Effect.sync(() => {
              event.sender.send("git:clone-progress", {
                line: line.line,
                timestamp: new Date().toISOString(),
              })
            }),
          )

          // debugLog("[git:clone] getting exit code...")
          const exitCode = yield* proc.exitCode
          // debugLog("[git:clone] exit code: " + exitCode)
          if (exitCode !== 0) {
            return yield* Effect.fail(
              new GitError({
                command: "git clone",
                stderr: `clone to ${paths.absolutePath} failed`,
                exitCode,
              }),
            )
          }

          event.sender.send("git:clone-progress", {
            line: "Clone complete. Counting files...",
            timestamp: new Date().toISOString(),
          })

          // Count tracked files using `git ls-files` (fast, ~10ms)
          const fileCount = yield* countFiles(paths.absolutePath)

          // Register the worktree path
          sessionManager.registerWorkTreePath(paths.absolutePath)
          // debugLog("[git:clone] registered worktree, returning result")

          return {
            absolutePath: paths.absolutePath,
            relativePath: paths.relativePath,
            fileCount,
            status: "success" as const,
            outputs: {
              clone_path: paths.absolutePath,
            },
          }
        }),
        ),
      )
    },
  )

  ipcMain.handle(
    "git:push",
    async (
      event,
      params: {
        worktreePath: string
        remote: string
        branch: string
        token?: string
        setUpstream?: boolean
      },
    ) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          yield* validateSessionPath(params.worktreePath)

          const options: PushOptions = {
            token: params.token,
            setUpstream: params.setUpstream,
          }

          event.sender.send("git:push-progress", {
            line: `Pushing ${params.branch} to ${params.remote}...`,
            timestamp: new Date().toISOString(),
          })

          yield* pushBranch(
            params.worktreePath,
            params.remote,
            params.branch,
            options,
          )

          event.sender.send("git:push-progress", {
            line: `Push complete.`,
            timestamp: new Date().toISOString(),
          })

          return { ok: true as const }
        }),
      )
    },
  )

  ipcMain.handle(
    "git:pull-request",
    async (
      _event,
      params: { token: string } & CreatePullRequestParams,
    ) => {
      const { token, ...prParams } = params
      return runtime.runPromise(createPullRequest(token, prParams))
    },
  )

  ipcMain.handle(
    "git:delete-branch",
    async (_event, params: { worktreePath: string; branch: string }) => {
      return runtime.runPromise(
        Effect.gen(function* () {
          yield* validateSessionPath(params.worktreePath)
          return yield* deleteBranch(params.worktreePath, params.branch)
        }),
      )
    },
  )
}
