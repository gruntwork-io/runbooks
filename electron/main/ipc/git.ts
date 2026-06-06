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
import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { runtime, sessionManager, getSessionToken, getSessionTokenForProvider } from "./runtime.ts"
import { ProcessSpawner } from "../../../src/services/ProcessSpawner.ts"
import {
  resolveClonePaths,
  countFiles,
  deleteBranch,
  createPullRequest,
  createMergeRequest,
  isValidGitURL,
  parseOwnerRepoFromURL,
  type CreatePullRequestParams,
} from "../../../src/domain/git/operations.ts"
import { injectTokenIntoUrl } from "../../../src/domain/git/url.ts"
import { gitSpawnEnv } from "../../../src/domain/git/env.ts"
import { GitClient } from "../../../src/services/GitClient.ts"
import type { CloneOptions, PushOptions } from "../../../src/services/GitClient.ts"
import { isContainedIn } from "../../../src/path-validation.ts"
import { PathTraversalError, GitError, GitHubApiError, GitLabApiError } from "../../../src/errors/index.ts"
import { validateSessionPath } from "./path-guard.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("ipc:git:clone")

/**
 * Build a `git:log` progress sink bound to an invoke event. Each handler that
 * streams human-readable progress lines to the renderer uses one of these.
 */
const makeSendLog = (event: IpcMainInvokeEvent) => (line: string) =>
  event.sender.send("git:log", { line, timestamp: new Date().toISOString() })

/**
 * Resolve the GitHub token from the session env, failing with a typed
 * GitError so the failure flows through errorMessage() / git:error like every
 * other git failure. See getSessionToken() in runtime.ts for the shared lookup.
 */
const resolveGitToken = () =>
  getSessionToken(
    () =>
      new GitError({
        command: "resolve github token",
        stderr:
          "No GitHub token available in session. Authenticate with the GitHub Auth block before creating a pull request.",
        exitCode: 1,
      }),
  )

/**
 * Extract a human-readable message from a typed Effect failure so it can be
 * forwarded to the renderer via a git:error event.
 */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "_tag" in err) {
    const tag = (err as { _tag: string })._tag
    if (tag === "GitError") {
      const g = err as GitError
      // g.command already includes the "git " prefix (see GitCliClient.runGit).
      return g.stderr || `${g.command} failed (exit ${g.exitCode})`
    }
    if (tag === "PathTraversalError") {
      return (err as PathTraversalError).message
    }
    if (tag === "GitHubApiError" || tag === "GitLabApiError") {
      // Data.TaggedError extends Error but leaves the inherited Error.message
      // empty; the real text is the tagged `message` field. Fall back to the
      // status so the renderer never shows a bare "An error has occurred".
      const e = err as GitHubApiError | GitLabApiError
      return e.message || `${tag} (status ${e.status})`
    }
  }
  return err instanceof Error ? err.message : String(err)
}

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
    // Reuse the canonical extractor so the renderer-facing message stays
    // consistent with git:error events (handles GitError/PathTraversalError
    // and, defensively, the API error tags).
    throw new Error(errorMessage(failure.value))
  }
  throw new Error(Cause.pretty(exit.cause))
}

/** Renderer payload shared by the git:pull-request and git:merge-request handlers. */
interface GitPrParams {
  worktreePath: string
  owner: string
  repo: string
  title: string
  body?: string
  baseBranch: string
  headBranch: string
  commitMessage: string
  labels?: string[]
}

/** Map the renderer PR/MR payload to the domain create-params shape. */
function buildPrParams(params: GitPrParams, repoPath: string): CreatePullRequestParams {
  return {
    owner: params.owner,
    repo: params.repo,
    title: params.title,
    body: params.body,
    baseBranch: params.baseBranch,
    headBranch: params.headBranch,
    commitMessage: params.commitMessage,
    labels: params.labels,
    repoPath,
  }
}

/**
 * Shared response handling for git:pull-request and git:merge-request. On
 * success, emit git:pr-result + git:outputs + git:status and return the PR/MR
 * summary; on failure, emit a git:error (tagging the recoverable branch_exists
 * code) + git:status. `extraBranchExists` injects the MR-only HTTP-409 check;
 * the local-branch "already exists" case is handled generically for both.
 */
function respondToGitPrExit<A extends { url: string; number: number; branch: string }>(
  event: IpcMainInvokeEvent,
  exit: Exit.Exit<A, unknown>,
  headBranch: string,
  extraBranchExists?: (failureValue: unknown) => boolean,
): { url: string; number: number } | { error: string } {
  if (Exit.isSuccess(exit)) {
    const pr = exit.value
    event.sender.send("git:pr-result", {
      prUrl: pr.url,
      prNumber: pr.number,
      branchName: pr.branch,
    })
    event.sender.send("git:outputs", {
      outputs: {
        pr_url: pr.url,
        pr_number: String(pr.number),
        pr_branch: pr.branch,
      },
    })
    event.sender.send("git:status", { status: "success", exitCode: 0 })
    return { url: pr.url, number: pr.number }
  }

  const failure = Cause.failureOption(exit.cause)
  const failureValue = failure._tag === "Some" ? failure.value : undefined
  const message =
    failureValue !== undefined ? errorMessage(failureValue) : Cause.pretty(exit.cause)
  const code =
    extraBranchExists?.(failureValue) || /already exists/i.test(message)
      ? "branch_exists"
      : undefined

  event.sender.send("git:error", {
    message,
    ...(code ? { code, branchName: headBranch } : {}),
  })
  event.sender.send("git:status", { status: "fail", exitCode: 1 })

  return { error: message }
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
        provider?: "github" | "gitlab"
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

          // Resolve a token for private clones: prefer a renderer-supplied
          // token, otherwise fall back to the session env keyed by PROVIDER.
          // The provider comes from the linked Git Auth block (the renderer
          // passes it), NOT from the remote hostname — that's what lets
          // self-hosted GitHub/GitLab (arbitrary hostnames) resolve the right
          // token. For older callers that don't pass a provider, fall back to
          // the well-known SaaS hostnames. Public repos still clone with no
          // token (Effect.either turns "no session token" into "no auth").
          const cloneHost = (() => {
            try {
              return new URL(params.url).hostname
            } catch {
              return ""
            }
          })()
          const cloneProvider =
            params.provider ??
            (cloneHost === "gitlab.com"
              ? ("gitlab" as const)
              : cloneHost === "github.com"
                ? ("github" as const)
                : undefined)
          let resolvedToken = params.credentials?.token
          if (!resolvedToken && cloneProvider) {
            const sessionToken = yield* Effect.either(
              getSessionTokenForProvider(
                cloneProvider,
                () =>
                  new GitError({
                    command: "resolve git token",
                    stderr: "no session token",
                    exitCode: 1,
                  }),
              ),
            )
            resolvedToken =
              sessionToken._tag === "Right" ? sessionToken.right : undefined
          }

          const options: CloneOptions = {
            ref: params.ref,
            token: resolvedToken,
          }

          // Clone the repository using direct process spawning.
          // We avoid the GitClient's stream-based API because
          // Stream.runCollect hangs in Electron's runtime.runPromise.
          const spawner = yield* ProcessSpawner
          const cloneArgs = ["clone", "--progress"]
          if (options.ref) cloneArgs.push("--branch", options.ref)

          // GitLab wants username `oauth2` with the PAT as the password;
          // GitHub accepts the default `x-access-token`. Keyed on provider so a
          // self-hosted GitLab (non-gitlab.com host) still gets `oauth2`.
          const cloneUsername = cloneProvider === "gitlab" ? "oauth2" : "x-access-token"
          const effectiveUrl = options.token
            ? injectTokenIntoUrl(params.url, options.token, cloneUsername)
            : params.url

          cloneArgs.push(effectiveUrl, paths.absolutePath)

          log.debug("spawning git process...")
          // gitSpawnEnv keeps git/ssh non-interactive: an SSH clone of a host
          // not yet in known_hosts fails fast instead of hanging on the
          // host-key verification prompt.
          const proc = yield* spawner.spawn("git", cloneArgs, { env: gitSpawnEnv() })

          log.debug("draining output stream...")
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

          log.debug("getting exit code...")
          const exitCode = yield* proc.exitCode
          log.debug("exit code:", exitCode)
          if (exitCode !== 0) {
            const stderr = stderrLines.join("\n").trim()
            // With strict host-key checking, cloning a host that isn't in
            // known_hosts yet fails with "Host key verification failed." rather
            // than hanging on the interactive prompt. git's bare message gives
            // no remedy, so append the exact command to trust the host. The
            // host is pulled from the SSH/SCP-form URL (git@host:owner/repo),
            // for which new URL() yields no hostname.
            let stderrOut =
              stderr || `clone to ${paths.absolutePath} failed (exit ${exitCode})`
            if (/host key verification failed/i.test(stderr)) {
              const sshHost =
                params.url.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)/)?.[1] ?? "<host>"
              stderrOut +=
                `\n\nThe SSH host key for ${sshHost} isn't trusted yet. Add it to ` +
                `known_hosts, then clone again:\n  ssh-keyscan ${sshHost} >> ~/.ssh/known_hosts`
            }
            return yield* Effect.fail(
              new GitError({
                command: "git clone",
                stderr: stderrOut,
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
          log.debug("registered worktree, returning result")

          // Surface org/repo from the clone URL so downstream templates can
          // reference {{ .outputs.<id>.repo_owner }} / .repo_name.
          const parsed = parseOwnerRepoFromURL(effectiveUrl)

          return {
            absolutePath: paths.absolutePath,
            relativePath: paths.relativePath,
            fileCount,
            status: "success" as const,
            outputs: {
              clone_path: paths.absolutePath,
              ...(parsed ? { repo_owner: parsed.owner, repo_name: parsed.repo } : {}),
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
        branchName: string
        provider?: "github" | "gitlab"
      },
    ) => {
      const sendLog = makeSendLog(event)

      const program = Effect.gen(function* () {
        const repoPath = yield* validateSessionPath(params.worktreePath)
        const gitClient = yield* GitClient

        // Resolve the token by PROVIDER (passed by the PR/MR block from its
        // linked auth block), so a GitLab push uses the GitLab token and a
        // GitHub push the GitHub token — never inferred from the remote host,
        // which would break self-hosted instances. Defaults to github for older
        // callers that don't pass a provider.
        const provider = params.provider ?? "github"
        const token = yield* getSessionTokenForProvider(
          provider,
          () =>
            new GitError({
              command: "resolve git token",
              stderr: `No ${provider} token available in session. Authenticate with the matching Git Auth block before pushing.`,
              exitCode: 1,
            }),
        )

        const options: PushOptions = { token, setUpstream: true }

        sendLog(`Pushing ${params.branchName} to origin…`)
        yield* gitClient.push(repoPath, "origin", params.branchName, options)
        sendLog("Push complete.")
      })

      const exit = await runtime.runPromiseExit(program)

      if (Exit.isSuccess(exit)) {
        event.sender.send("git:status", { status: "success", exitCode: 0 })
        return { ok: true as const }
      }

      const failure = Cause.failureOption(exit.cause)
      const message =
        failure._tag === "Some"
          ? errorMessage(failure.value)
          : Cause.pretty(exit.cause)
      event.sender.send("git:error", { message })
      event.sender.send("git:status", { status: "fail", exitCode: 1 })
      return { error: message }
    },
  )

  ipcMain.handle("git:pull-request", async (event, params: GitPrParams) => {
    const sendLog = makeSendLog(event)

    // Resolve the token server-side, map the renderer payload to the domain
    // shape, and create the PR. We run via runPromiseExit (instead of
    // runAndUnwrap) so that on failure we can emit a structured git:error
    // event the renderer can act on (e.g. the branch_exists recovery flow).
    const program = Effect.gen(function* () {
      const repoPath = yield* validateSessionPath(params.worktreePath)
      const token = yield* resolveGitToken()
      // sendLog is threaded in as the progress sink so each line is emitted
      // when its step actually runs, not all at once before the work starts.
      return yield* createPullRequest(token, buildPrParams(params, repoPath), sendLog)
    })

    return respondToGitPrExit(event, await runtime.runPromiseExit(program), params.headBranch)
  })

  ipcMain.handle("git:merge-request", async (event, params: GitPrParams) => {
    const sendLog = makeSendLog(event)

    // Mirrors git:pull-request but resolves the GitLab token (not the
    // github-pinned resolveGitToken) and opens an MR. Reuses the git:pr-result
    // / git:outputs / git:error contract so the renderer handles both
    // providers with one set of event listeners.
    const program = Effect.gen(function* () {
      const repoPath = yield* validateSessionPath(params.worktreePath)
      const token = yield* getSessionTokenForProvider(
        "gitlab",
        () =>
          new GitError({
            command: "resolve gitlab token",
            stderr:
              "No GitLab token available in session. Authenticate with the GitLab Auth block before creating a merge request.",
            exitCode: 1,
          }),
      )
      // The MR targets the repo's own GitLab instance, which createMergeRequest
      // derives from the repo's remote URL — no need to thread a host here.
      return yield* createMergeRequest(token, buildPrParams(params, repoPath), sendLog)
    })

    // GitLab rejects the create with HTTP 409 when an MR already exists for the
    // source branch; its message is unreliable, so match the status, not the
    // text. (The local-branch "already exists" case is handled generically.)
    const isExistingMr = (failureValue: unknown) =>
      !!failureValue &&
      typeof failureValue === "object" &&
      "_tag" in failureValue &&
      (failureValue as { _tag: string })._tag === "GitLabApiError" &&
      (failureValue as GitLabApiError).status === 409

    return respondToGitPrExit(
      event,
      await runtime.runPromiseExit(program),
      params.headBranch,
      isExistingMr,
    )
  })

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
