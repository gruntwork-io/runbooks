/**
 * IPC handlers for git operations with streaming progress.
 *
 * Clone and push operations stream progress events to the renderer via
 * event.sender.send(). Pull request creation and branch deletion are
 * simple request-response handlers.
 */
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { Cause, Effect, Exit, Stream } from "effect"
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

/**
 * Run an Effect program and surface typed failures as plain Errors whose
 * message carries the real failure detail (e.g. git stderr).
 *
 * Effect's TaggedError inherits from Error but leaves `.message` empty, so
 * across the IPC boundary the renderer would otherwise only see "An error
 * has occurred". Unwrapping the Cause here and rethrowing a regular Error
 * keeps the real message flowing through Electron's IPC serialization.
 */
async function runAndUnwrap<A, E extends { _tag: string }>(
  program: Effect.Effect<A, E, never>,
): Promise<A> {
  const exit = await runtime.runPromiseExit(program)
  if (Exit.isSuccess(exit)) return exit.value

  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === "Some") {
    const err = failure.value as GitError | PathTraversalError | { _tag: string }
    if (err._tag === "GitError") {
      const gitErr = err as GitError
      throw new Error(
        gitErr.stderr || `git ${gitErr.command} failed (exit ${gitErr.exitCode})`,
      )
    }
    if (err._tag === "PathTraversalError") {
      throw new Error((err as PathTraversalError).message)
    }
    throw new Error(String(err))
  }
  throw new Error(Cause.pretty(exit.cause))
}

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
        force?: boolean
      },
    ) => {
      return runAndUnwrap(
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

          // If the destination already exists, either surface directory_exists
          // so the renderer can prompt the user, or delete it when force=true
          // (from "Delete & Clone"). The isContainedIn check above gates the
          // rm so a malformed localPath cannot wipe anything outside the
          // session working dir.
          if (existsSync(paths.absolutePath)) {
            if (!params.force) {
              return { error: "directory_exists" as const }
            }
            yield* Effect.tryPromise({
              try: () => rm(paths.absolutePath, { recursive: true, force: true }),
              catch: (e) =>
                new GitError({
                  command: "rm -rf",
                  stderr: e instanceof Error ? e.message : String(e),
                  exitCode: 1,
                }),
            })
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
          const stderrLines: string[] = []
          yield* Stream.runForEach(proc.output, (line) =>
            Effect.sync(() => {
              if (line.source === "stderr") stderrLines.push(line.line)
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
            const stderr = stderrLines.join("\n").trim()
            return yield* Effect.fail(
              new GitError({
                command: "git clone",
                stderr: stderr || `clone to ${paths.absolutePath} failed (exit ${exitCode})`,
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
      return runAndUnwrap(
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
      return runAndUnwrap(createPullRequest(token, prParams))
    },
  )

  ipcMain.handle(
    "git:delete-branch",
    async (_event, params: { worktreePath: string; branch: string }) => {
      return runAndUnwrap(
        Effect.gen(function* () {
          yield* validateSessionPath(params.worktreePath)
          return yield* deleteBranch(params.worktreePath, params.branch)
        }),
      )
    },
  )
}
