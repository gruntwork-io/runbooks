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
import {
  cloneRepository,
  resolveClonePaths,
  countFiles,
  deleteBranch,
  createPullRequest,
  pushBranch,
  type CreatePullRequestParams,
} from "../../../src/domain/git/operations.ts"
import type { CloneOptions, PushOptions } from "../../../src/services/GitClient.ts"
import { isContainedIn } from "../../../src/path-validation.ts"
import { PathTraversalError } from "../../../src/errors/index.ts"
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
        Effect.gen(function* () {
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

          // Get the progress stream
          const progressStream = yield* cloneRepository(
            params.url,
            paths.absolutePath,
            options,
          )

          // Stream progress events to the renderer
          yield* Stream.runForEach(progressStream, (progress) =>
            Effect.sync(() => {
              event.sender.send("git:clone-progress", {
                line: progress.line,
                timestamp: progress.timestamp,
              })
            }),
          )

          // Count files in the cloned repo
          const fileCount = yield* countFiles(paths.absolutePath)

          // Register the worktree path
          sessionManager.registerWorkTreePath(paths.absolutePath)

          return {
            absolutePath: paths.absolutePath,
            relativePath: paths.relativePath,
            fileCount,
          }
        }),
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
