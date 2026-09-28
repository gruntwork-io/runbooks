/**
 * IPC handlers for git operations with streaming progress.
 *
 * Clone and push operations stream progress events to the renderer via
 * event.sender.send(). Pull request creation and branch deletion are
 * simple request-response handlers.
 */
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { Cause, Effect, Exit, ManagedRuntime, Stream } from "effect"
import { ipcMain, type IpcMainInvokeEvent } from "electron"
import {
  runtime,
  sessionManager,
  getGitHubSessionCredential,
  getGitLabSessionBoundHost,
  getGitLabSessionTokenForOrigin,
  getSessionTokenForHost,
  getSessionTokenForProvider,
} from "./runtime.ts"
import { ProcessSpawner } from "../../../src/services/ProcessSpawner.ts"
import {
  resolveClonePaths,
  countFiles,
  deleteBranch,
  createPullRequest,
  createMergeRequest,
  seedDefaultBranch,
  gitlabInstanceForRemoteUrl,
  unbornBranchName,
  isValidGitURL,
  parseOwnerRepoFromURL,
  type CreatePullRequestParams,
} from "../../../src/domain/git/operations.ts"
import { inspectLocalRepo } from "../../../src/domain/git/local-repo.ts"
import { buildCloneSteps, normalizeRepoPath } from "../../../src/domain/git/cloneSteps.ts"
import { getRepo } from "../../../src/domain/github/auth.ts"
import {
  gitCredentialUsername,
  isHttpRemoteUrl,
  isPlainHttpRemoteUrl,
  withGitHttpAuth,
} from "../../../src/domain/git/url.ts"
import { gitHostFromRemoteUrl } from "../../../src/domain/git/gitlab-host.ts"
import { parseGitRemoteUrl } from "../../../src/domain/git/remote-url.ts"
import { isGitHubHost, tryNormalizeGitHubHost } from "../../../src/domain/git/github-host.ts"
import { gitSpawnEnv, resolveSshCommand } from "../../../src/domain/git/env.ts"
import { GitClient } from "../../../src/services/GitClient.ts"
import type { CloneOptions, PushOptions } from "../../../src/services/GitClient.ts"
import { GitError } from "../../../src/errors/index.ts"
import { validateCloneDestination, validateSessionPath } from "./path-guard.ts"
import { describeCause } from "./ipc-error.ts"
import { isLocalBranchConflict, prBlockOutputs } from "./git-pr-result.ts"
import { makeLogger } from "../logger.ts"
import type { GitCloneRequest, GitLocalRepoResponse } from "../../shared/channels.ts"

const log = makeLogger("ipc:git:clone")

/**
 * Build a `git:log` progress sink bound to an invoke event. Each handler that
 * streams human-readable progress lines to the renderer uses one of these.
 */
const makeSendLog = (event: IpcMainInvokeEvent) => (line: string) =>
  event.sender.send("git:log", { line, timestamp: new Date().toISOString() })

/**
 * Fail when a repo's origin is plain http: pushing to it would send the
 * session token in cleartext. (An SSH origin authenticates with keys; the
 * token then goes only to the provider's https API.) "Plain http" is read the
 * way withGitHttpAuth reads the URL (isPlainHttpRemoteUrl), so every origin
 * the push would attach the token to in cleartext is caught, however it is
 * spelled. The message names the host only: the remote may carry credentials.
 */
const refusePlainHttpOrigin = (
  remoteUrl: string,
  failWith: (stderr: string) => GitError,
  provider: string,
  purpose: string,
) =>
  isPlainHttpRemoteUrl(remoteUrl)
    ? Effect.fail(
        failWith(
          `This repository's origin on ${gitHostFromRemoteUrl(remoteUrl) ?? "an unknown host"} uses plain http, ` +
            `and the ${provider} token is only sent over https. Point origin at an https or SSH URL before ${purpose}.`,
        ),
      )
    : Effect.void

/**
 * Resolve the session's GitHub token for a repo on disk, HOST-BOUND to the
 * repo's origin: the token is released only when it belongs to the host
 * `origin` points at (github.com, a GHES host, or a ghe.com tenant), so a
 * github.com token is never pushed to an enterprise host or the reverse, and
 * never when origin is plain http. Yields the host too — the PR API calls go
 * to that host. Fails with a typed GitError (so it flows through
 * failureMessage() / git:error like every other git failure) naming both hosts
 * on a mismatch.
 *
 * The host is read the way withGitHttpAuth reads it (gitHostFromRemoteUrl),
 * so it is the host the token would really go to. When origin has no GitHub
 * host (SSH to an IPv6 literal or zone id, a local path, or no origin that
 * could be read):
 *
 *  - a push (`callsApi: false`) uses the session's own credential: such a
 *    push never carries the token, which withGitHttpAuth attaches to http(s)
 *    remotes only.
 *  - a flow that calls the GitHub API with the token (`callsApi: true`: a
 *    pull request, or the commit author lookup) is refused. Its requests
 *    would otherwise go to the session's host, github.com unless configured
 *    otherwise, which is not where the repo was shown to live.
 *
 * An http(s) origin whose host can't be matched is refused either way.
 */
const resolveGitHubTokenForRepo = (
  repoPath: string,
  purpose: string,
  { callsApi }: { readonly callsApi: boolean },
) =>
  Effect.gen(function* () {
    const failWith = (stderr: string) =>
      new GitError({ command: "resolve github token", stderr, exitCode: 1 })
    const gitClient = yield* GitClient
    const remoteUrl = yield* gitClient.getRemoteUrl(repoPath).pipe(Effect.orElseSucceed(() => ""))
    yield* refusePlainHttpOrigin(remoteUrl, failWith, "GitHub", purpose)
    const remoteHost = gitHostFromRemoteUrl(remoteUrl)
    const origin = tryNormalizeGitHubHost(remoteHost)
    const session = yield* getGitHubSessionCredential(undefined, () =>
      failWith(`No GitHub token available in session. Authenticate with the GitHub Auth block before ${purpose}.`),
    )
    if (origin === undefined && isHttpRemoteUrl(remoteUrl)) {
      return yield* Effect.fail(
        failWith(
          `The GitHub credential in this session is for ${session.host}, but this repository's origin is ` +
            `${remoteHost ?? "an unknown host"}, which is not a GitHub host. Point origin at a GitHub host before ${purpose}.`,
        ),
      )
    }
    if (origin === undefined && callsApi) {
      // The remote itself stays out of the message: one that doesn't parse
      // may still carry credentials stripUrlCredentials couldn't find.
      return yield* Effect.fail(
        failWith(
          remoteUrl
            ? "Couldn't tell which GitHub host this repository's origin remote is on" +
                (remoteHost ? ` (${remoteHost} is not a GitHub host name)` : "") +
                ", so the GitHub token was not sent anywhere. Point origin at the repository on your " +
                `GitHub host before ${purpose}.`
            : "This repository has no origin remote, so there is no GitHub host to send the GitHub token " +
                `to. Add an origin that points at the repository on your GitHub host before ${purpose}.`,
        ),
      )
    }
    if (origin === undefined || origin === session.host) return session
    return yield* getGitHubSessionCredential(origin, () =>
      failWith(
        `The GitHub credential in this session is for ${session.host}, but this repository's origin is ${origin}. ` +
          `Authenticate a GitHub Auth block for ${origin} before ${purpose}.`,
      ),
    )
  })

/**
 * GitLab counterpart of resolveGitHubTokenForRepo: the session's GitLab token
 * is released only when the repo's origin is on the host it is bound to
 * (getGitLabSessionBoundHost), and never when origin is plain http. The origin
 * may be any repo a runbook cloned, and the token goes to origin's instance
 * API (the commit author, the MR) as well as to origin itself (the push).
 * When there is no origin, or origin names no host, it is refused
 * (gitlabInstanceForRemoteUrl): there is no host to bind to, and gitlab.com
 * is never assumed.
 */
const resolveGitLabTokenForRepo = (repoPath: string, purpose: string) =>
  Effect.gen(function* () {
    const failWith = (stderr: string) =>
      new GitError({ command: "resolve gitlab token", stderr, exitCode: 1 })
    const gitClient = yield* GitClient
    const remoteUrl = yield* gitClient.getRemoteUrl(repoPath).pipe(Effect.orElseSucceed(() => ""))
    yield* refusePlainHttpOrigin(remoteUrl, failWith, "GitLab", purpose)
    yield* getSessionTokenForProvider("gitlab", () =>
      failWith(`No GitLab token available in session. Authenticate with the GitLab Auth block before ${purpose}.`),
    )
    const apiBase = yield* gitlabInstanceForRemoteUrl(remoteUrl, purpose)
    const origin = new URL(apiBase).host
    const boundHost = yield* getGitLabSessionBoundHost()
    return yield* getGitLabSessionTokenForOrigin(apiBase, () =>
      failWith(
        (boundHost
          ? `The GitLab credential in this session is for ${boundHost}, but this repository's origin is ${origin}. `
          : "The GitLab credential in this session is not bound to a host: GITLAB_HOST was changed after the GitLab Auth block ran, or cannot be parsed. ") +
          `Authenticate a GitLab Auth block for ${origin} before ${purpose}.`,
      ),
    )
  })

/**
 * The renderer-facing message for a failed git handler run, whether it is
 * thrown, returned as `{ error }` or sent as a git:error event. It is
 * describeCause() (ipc-error.ts), like every other IPC error: the real
 * failure detail (e.g. git stderr), the tag of a message-less tagged error
 * such as SessionNotFoundError rather than "", and a defect's message without
 * stack frames. A defect is a bug rather than a git failure, so its full
 * Cause goes to MAIN's log instead.
 */
function failureMessage(cause: Cause.Cause<unknown>): string {
  if (Cause.isDie(cause)) log.error("git handler defect:", Cause.pretty(cause))
  return describeCause(cause)
}

/**
 * Run an Effect program and surface failures as plain Errors whose message is
 * failureMessage(), so the real detail, not a FiberFailure dump, crosses IPC.
 */
async function runAndUnwrap<A, E extends { _tag: string }>(
  program: Effect.Effect<A, E, ManagedRuntime.ManagedRuntime.Context<typeof runtime>>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await runtime.runPromiseExit(program, { signal })
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(failureMessage(exit.cause))
}

// Clones in flight, keyed by the renderer-supplied cloneId so git:clone-cancel
// can stop a specific one. Aborting a controller interrupts that clone's fiber
// (the signal is passed to runAndUnwrap), and interruption kills git — see the
// release registered where the git process is spawned. `settled` resolves once
// the clone has returned, its clean-up included.
interface ActiveClone {
  controller: AbortController
  settled: Promise<void>
}
const activeClones = new Map<string, ActiveClone>()

// How long git:clone-cancel waits for the cancelled clone to finish cleaning
// up before it replies anyway. The clean-up waits for git to exit, which
// ChildProcessSpawner's kill forces with SIGKILL 5 seconds after its SIGTERM,
// then removes the checkout.
const CLONE_CANCEL_REPLY_WAIT_MS = 10_000

/**
 * Run a clone so that git:clone-cancel can stop it. A cancelled clone resolves
 * to `{ status: "cancelled" }` rather than rejecting with the interruption:
 * the user asked for it, so it is not an error.
 */
async function runCancellableClone<A>(
  cloneId: string | undefined,
  run: (signal: AbortSignal) => Promise<A>,
): Promise<A | { status: "cancelled" }> {
  const controller = new AbortController()
  let settle = () => {}
  const clone: ActiveClone = { controller, settled: new Promise((resolve) => (settle = resolve)) }
  if (cloneId) activeClones.set(cloneId, clone)
  try {
    return await run(controller.signal)
  } catch (err) {
    if (controller.signal.aborted) return { status: "cancelled" }
    throw err
  } finally {
    settle()
    if (cloneId && activeClones.get(cloneId) === clone) activeClones.delete(cloneId)
  }
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
 * code only for a local branch-name collision) + git:status.
 */
function respondToGitPrExit<A extends { url: string; number: number; branch: string }>(
  event: IpcMainInvokeEvent,
  exit: Exit.Exit<A, unknown>,
  headBranch: string,
): { url: string; number: number } | { error: string } {
  if (Exit.isSuccess(exit)) {
    const pr = exit.value
    event.sender.send("git:pr-result", {
      prUrl: pr.url,
      prNumber: pr.number,
      branchName: pr.branch,
    })
    event.sender.send("git:outputs", { outputs: prBlockOutputs(pr) })
    event.sender.send("git:status", { status: "success", exitCode: 0 })
    return { url: pr.url, number: pr.number }
  }

  const message = failureMessage(exit.cause)
  const code = isLocalBranchConflict(message) ? "branch_exists" : undefined

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
    async (event, params: GitCloneRequest) => {
      // A clone can take minutes; if a different runbook opens meanwhile, the
      // finished checkout must not become that runbook's active worktree.
      const generation = sessionManager.getGeneration()
      return runCancellableClone(params.cloneId, (signal) => runAndUnwrap(
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

          // Validate the sparse-checkout path too, before a forced clone
          // deletes the destination below.
          const repoPath = yield* normalizeRepoPath(params.repo_path)

          // Resolve clone destination paths
          const session = yield* sessionManager.getSession()
          const paths = yield* resolveClonePaths(
            params.localPath,
            params.url,
            session.workingDir,
          )

          // Validate the clone destination before the existence check, so a
          // bad localPath is an inline error, never a "Delete & Clone" prompt.
          yield* validateCloneDestination(
            paths.absolutePath,
            session.workingDir,
            session.runbookPath,
          )

          // If the destination already exists, either surface directory_exists
          // so the renderer can prompt the user, or delete it when force=true
          // (from "Delete & Clone"). validateCloneDestination above gates the
          // rm: the destination is a strict subdirectory of the session working
          // dir once symlinks are resolved, and doesn't contain the runbook.
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
          //
          // A session token is also HOST-BOUND: it is released only when the
          // clone URL's host is the host the credential belongs to (the GitHub
          // credential's host — github.com, a GHES host, or a ghe.com tenant —
          // or the GITLAB_HOST written with GITLAB_TOKEN), and never for a
          // plain http URL, so a runbook's clone URL can never carry it to
          // another host or send it in cleartext. (Over SSH git authenticates
          // with keys; the token only reaches the https API below.)
          const cloneUrl = URL.canParse(params.url) ? new URL(params.url) : undefined
          const cloneHost = cloneUrl?.host.toLowerCase() ?? ""
          const cloneProvider =
            params.provider ??
            (cloneHost === "gitlab.com"
              ? ("gitlab" as const)
              : isGitHubHost(cloneHost)
                ? ("github" as const)
                : undefined)
          let resolvedToken = params.credentials?.token
          if (!resolvedToken && cloneProvider && cloneUrl?.protocol !== "http:") {
            const noToken = () =>
              new GitError({
                command: "resolve git token",
                stderr: "no session token",
                exitCode: 1,
              })
            const sessionToken = yield* Effect.either(
              getSessionTokenForHost(cloneProvider, cloneHost, noToken),
            )
            resolvedToken =
              sessionToken._tag === "Right" ? sessionToken.right : undefined
          }

          const options: CloneOptions = {
            ref: params.ref,
            token: resolvedToken,
          }

          // Spawn git directly instead of going through GitClient.cloneSimple:
          //  - cloneSimple buffers all output, but this handler forwards each
          //    `--progress` line to the renderer (git:clone-progress) as it
          //    arrives;
          //  - each step is spawned in its own scope, so git:clone-cancel can
          //    kill the one that is running (see the release below);
          //  - the stderr lines are kept so host-key failures can get a remedy
          //    added.
          const spawner = yield* ProcessSpawner

          // One `git clone`, or a sparse clone of `repo_path` in several steps
          // (see buildCloneSteps). Each step streams its progress and fails the
          // clone the same way. `--` (inside gitCloneArgs, which builds the
          // clone step) backs up isValidGitURL: the URL is never read as a git
          // option.
          const cloneSteps = yield* buildCloneSteps(params.url, paths.absolutePath, {
            ref: options.ref,
            repoPath,
          })

          // gitSpawnEnv keeps git/ssh non-interactive: an SSH clone of a host
          // not yet in known_hosts fails fast instead of hanging on the
          // host-key verification prompt. The repo doesn't exist yet (nor may a
          // nested localPath's parent), so the user's core.sshCommand is looked
          // up once, from the working dir the clone lands in. The token goes in
          // the environment, not the URL, so it is never saved as the
          // checkout's origin URL in .git/config. The credential username is
          // keyed on provider so a self-hosted GitLab (non-gitlab.com host)
          // still gets `oauth2`. Every step gets the same env, ssh command and
          // auth: a sparse clone is blobless, so its final checkout fetches
          // file contents from origin.
          const sshCommand = yield* resolveSshCommand(session.workingDir)
          const env = withGitHttpAuth(
            gitSpawnEnv(sshCommand),
            params.url,
            options.token,
            gitCredentialUsername(cloneProvider),
          )

          // Whether this clone creates the destination. The check above returned
          // or deleted an existing one, so it only exists here if something
          // made it since, and a cancel then leaves it alone.
          const createsDestination = !existsSync(paths.absolutePath)

          // A cancelled clone takes its checkout with it, from the first git
          // step until the result is returned (a cancel during the lookups
          // below would otherwise leave a full checkout behind). Only a
          // directory this clone created is removed, never one that was there
          // before. This scope closes after each step's own scope, and a
          // step's release waits for the git it killed to exit, so no git is
          // still writing into the directory when it goes.
          if (createsDestination) {
            yield* Effect.addFinalizer((exit) =>
              Exit.isInterrupted(exit)
                ? Effect.tryPromise(() => rm(paths.absolutePath, { recursive: true, force: true })).pipe(
                    Effect.catchAll((e) =>
                      Effect.sync(() => log.warn("failed to remove cancelled clone:", e)),
                    ),
                  )
                : Effect.void,
            )
          }

          for (const step of cloneSteps) {
            // A repository with no commits has nothing to check out: skip the
            // sparse clone's checkout, so the clone is reported as empty below
            // (hasCommits: false) just as it is without a repo path.
            if (step.skipIfNoCommits) {
              const client = yield* GitClient
              const cloned = yield* client
                .hasCommits(paths.absolutePath)
                .pipe(Effect.orElseSucceed(() => true))
              if (!cloned) continue
            }

            // Each step gets its own scope, so the kill below is tied to the
            // step that is running: a step that already exited is not signalled.
            yield* Effect.scoped(Effect.gen(function* () {
              log.debug("spawning git process...")
              // git:clone-cancel interrupts this fiber. Kill git when that happens,
              // or it keeps writing into the destination after the renderer has
              // moved on (and races a "Delete & Clone" of the same directory).
              // Then wait for it to exit (the kill escalates to SIGKILL after 5
              // seconds; a timeout here could not cut the wait short, because a
              // release runs uninterruptibly), so the finalizer
              // above removes the directory only once git is done with it.
              const proc = yield* Effect.acquireRelease(
                spawner.spawn("git", step.args, { env }),
                (spawned, exit) =>
                  Exit.isInterrupted(exit)
                    ? spawned.kill.pipe(
                        Effect.zipRight(
                          spawned.exitCode.pipe(Effect.ignore),
                        ),
                      )
                    : Effect.void,
              )

              log.debug("draining output stream...")
              const stderrLines: string[] = []
              yield* Stream.runForEach(proc.output, (line) =>
                Effect.sync(() => {
                  if (line.source === "stderr") stderrLines.push(line.line)
                  event.sender.send("git:clone-progress", {
                    line: line.line,
                    timestamp: new Date().toISOString(),
                    cloneId: params.cloneId,
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
                // host and any port come from parseGitRemoteUrl, which also reads
                // the SSH/SCP form (git@host:owner/repo, git@[::1]:owner/repo)
                // that new URL() can't. ssh-keyscan takes an IPv6 literal without
                // its brackets, and the port as -p.
                let stderrOut =
                  stderr || `clone to ${paths.absolutePath} failed (exit ${exitCode})`
                if (/host key verification failed/i.test(stderr)) {
                  const remote = parseGitRemoteUrl(params.url)
                  const keyscanTarget = remote?.hostname
                    ? `${remote.port ? `-p ${remote.port} ` : ""}${remote.hostname.replace(/^\[(.*)\]$/, "$1")}`
                    : "<host>"
                  stderrOut +=
                    `\n\nThe SSH host key for ${remote?.host || "<host>"} isn't trusted yet. Add it to ` +
                    `known_hosts, then clone again:\n  ssh-keyscan ${keyscanTarget} >> ~/.ssh/known_hosts`
                }
                return yield* Effect.fail(
                  new GitError({
                    command: "git clone",
                    stderr: stderrOut,
                    exitCode,
                  }),
                )
              }
            }))
          }

          event.sender.send("git:clone-progress", {
            line: "Clone complete. Counting files...",
            timestamp: new Date().toISOString(),
            cloneId: params.cloneId,
          })

          // Count tracked files using `git ls-files` (fast, ~10ms)
          const fileCount = yield* countFiles(paths.absolutePath)

          // Report the ref the clone actually landed on rather than letting the
          // renderer assume one. Cloning without an explicit `ref` follows the
          // remote's default branch, which is not always "main" — and that ref
          // becomes the base branch of any pull request opened against this
          // checkout, so guessing it wrong fails the PR at the very last step.
          const gitClient = yield* GitClient
          // Best-effort, like every other caller: a failed query must not fail
          // the whole clone after it already landed on disk, which would lose
          // the outputs and skip worktree registration. A repo we cannot read
          // counts as having history, so nobody is offered a seeded branch by
          // mistake.
          const hasCommits = yield* gitClient
            .hasCommits(paths.absolutePath)
            .pipe(Effect.orElseSucceed(() => true))
          const clonedRef = hasCommits
            ? (yield* gitClient
                .getCurrentBranch(paths.absolutePath)
                .pipe(Effect.orElseSucceed(() => "")))
            : // An empty repo has no branch yet; HEAD still names the one the
              // remote advertised, which is what a seeded first commit should
              // become.
              ((yield* unbornBranchName(paths.absolutePath)) ?? "")

          // Surface org/repo from the clone URL so downstream templates can
          // reference {{ .outputs.<id>.repo_owner }} / .repo_name. For GitHub
          // clones with a token, also resolve immutable numeric IDs (stable
          // across renames/transfers) via the REST API.
          const parsed = parseOwnerRepoFromURL(params.url)
          const outputs: Record<string, string> = {
            clone_path: paths.absolutePath,
            ...(parsed ? { repo_owner: parsed.owner, repo_name: parsed.repo } : {}),
          }

          if (parsed && resolvedToken && cloneProvider === "github" && cloneHost) {
            const repoResult = yield* Effect.either(
              getRepo(resolvedToken, parsed.owner, parsed.repo, cloneHost),
            )
            if (repoResult._tag === "Right") {
              outputs.org_id = String(repoResult.right.ownerId)
              outputs.repo_id = String(repoResult.right.id)
            } else {
              log.debug(
                "failed to resolve GitHub org/repo IDs (non-fatal):",
                repoResult.left,
              )
            }
          }

          // Register the worktree path last, with nothing that can be
          // interrupted between it and the return: a cancelled clone must not
          // stay registered, where it would become the active worktree.
          sessionManager.registerWorkTreePath(paths.absolutePath, generation)
          log.debug("registered worktree, returning result")

          return {
            absolutePath: paths.absolutePath,
            relativePath: paths.relativePath,
            fileCount,
            ref: clonedRef,
            hasCommits,
            status: "success" as const,
            outputs,
          }
        }),
        ),
        signal,
      ))
    },
  )

  ipcMain.handle("git:clone-cancel", async (_event, params: { cloneId: string }) => {
    // A clone that already finished (or never started) has nothing to stop.
    const clone = activeClones.get(params.cloneId)
    if (!clone) return { ok: true as const }
    clone.controller.abort()
    // Reply once the clone has stopped: git has exited and the checkout it
    // made is removed, so the renderer, which re-enables Clone and Delete &
    // Clone on this reply, never starts one while that is still going on. The
    // wait is bounded, so a clean-up that hangs can't hold the block forever.
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      clone.settled,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, CLONE_CANCEL_REPLY_WAIT_MS))),
    ])
    clearTimeout(timer)
    return { ok: true as const }
  })

  // Select an existing local checkout instead of cloning. The user picks the
  // directory (native dialog or by typing a path), so registering it as a
  // worktree here is the grant that lets the workspace/PR handlers touch a
  // repo outside the session working directory.
  ipcMain.handle(
    "git:local-repo",
    async (
      _event,
      params: { path: string; register?: boolean; provider?: "github" | "gitlab" },
    ): Promise<GitLocalRepoResponse> => {
      const generation = sessionManager.getGeneration()
      const program = Effect.gen(function* () {
        const session = yield* sessionManager.getSession()
        const info = yield* inspectLocalRepo(params.path, session.workingDir)

        if (params.register) {
          sessionManager.registerWorkTreePath(info.absolutePath, generation)
          log.debug("registered local checkout as worktree:", info.absolutePath)
        }

        // Same output contract as a clone, so runbooks referencing
        // {{ .outputs.<id>.clone_path }} work with either source.
        const outputs: Record<string, string> = {
          clone_path: info.absolutePath,
          ...(info.owner && info.repo
            ? { repo_owner: info.owner, repo_name: info.repo }
            : {}),
        }

        // GitHub numeric IDs, when a token is available — mirrors git:clone.
        // Host-bound to the checkout's own remote host. A remote with no
        // GitHub host is left alone rather than looked up on the session's
        // host (github.com by default): the repo was never shown to live
        // there, and a same-named repo there would report the wrong IDs.
        const remoteHost = tryNormalizeGitHubHost(gitHostFromRemoteUrl(info.remoteUrl ?? ""))
        if (
          params.register &&
          info.owner &&
          info.repo &&
          params.provider !== "gitlab" &&
          remoteHost !== undefined
        ) {
          const token = yield* Effect.either(
            getGitHubSessionCredential(
              remoteHost,
              () =>
                new GitError({
                  command: "resolve git token",
                  stderr: "no session token",
                  exitCode: 1,
                }),
            ),
          )
          if (token._tag === "Right") {
            const repoResult = yield* Effect.either(
              getRepo(token.right.token, info.owner, info.repo, token.right.host),
            )
            if (repoResult._tag === "Right") {
              outputs.org_id = String(repoResult.right.ownerId)
              outputs.repo_id = String(repoResult.right.id)
            } else {
              log.debug(
                "failed to resolve GitHub org/repo IDs (non-fatal):",
                repoResult.left,
              )
            }
          }
        }

        return {
          status: "success" as const,
          absolutePath: info.absolutePath,
          relativePath: info.relativePath,
          fileCount: info.fileCount,
          remoteUrl: info.remoteUrl,
          ref: info.branch,
          refType: info.refType,
          commitSha: info.commitSha,
          hasCommits: info.hasCommits,
          outputs,
        }
      })

      // A bad directory is user input, not an exception: return the message so
      // the block renders it inline instead of throwing across IPC.
      const exit = await runtime.runPromiseExit(program)
      if (Exit.isSuccess(exit)) return exit.value

      return { status: "fail" as const, error: failureMessage(exit.cause) }
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
        // callers that don't pass a provider. Either token is also bound to
        // origin's host, and never sent over plain http
        // (resolveGitHubTokenForRepo / resolveGitLabTokenForRepo).
        const provider = params.provider ?? "github"
        const token =
          provider === "github"
            ? (yield* resolveGitHubTokenForRepo(repoPath, "pushing", { callsApi: false })).token
            : yield* resolveGitLabTokenForRepo(repoPath, "pushing")

        const options: PushOptions = {
          token,
          username: gitCredentialUsername(provider),
          setUpstream: true,
        }

        sendLog(`Pushing ${params.branchName} to origin…`)
        yield* gitClient.push(repoPath, "origin", params.branchName, options)
        sendLog("Push complete.")
      })

      const exit = await runtime.runPromiseExit(program)

      if (Exit.isSuccess(exit)) {
        event.sender.send("git:status", { status: "success", exitCode: 0 })
        return { ok: true as const }
      }

      const message = failureMessage(exit.cause)
      event.sender.send("git:error", { message })
      event.sender.send("git:status", { status: "fail", exitCode: 1 })
      return { error: message }
    },
  )

  // Seed an empty repository with its default branch. Offered by <GitClone>
  // when it clones (or is pointed at) a repo that has no commits: without a
  // branch on the remote there is nothing for a later pull request to target,
  // and the failure would otherwise surface only after the runbook's work had
  // been committed and pushed.
  ipcMain.handle(
    "git:init-default-branch",
    async (
      event,
      params: {
        worktreePath: string
        branch: string
        provider?: "github" | "gitlab"
      },
    ) => {
      const sendLog = makeSendLog(event)

      const program = Effect.gen(function* () {
        const repoPath = yield* validateSessionPath(params.worktreePath)
        const provider = params.provider ?? "github"
        const { token, host } =
          provider === "github"
            ? yield* resolveGitHubTokenForRepo(repoPath, "creating the default branch", { callsApi: true })
            : {
                token: yield* resolveGitLabTokenForRepo(repoPath, "creating the default branch"),
                host: undefined,
              }

        const branch = params.branch.trim() || "main"
        return yield* seedDefaultBranch(token, { repoPath, branch, provider, host }, sendLog)
      })

      const exit = await runtime.runPromiseExit(program)

      if (Exit.isSuccess(exit)) {
        event.sender.send("git:status", { status: "success", exitCode: 0 })
        return { branch: exit.value.branch }
      }

      const message = failureMessage(exit.cause)
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
      // The token must belong to the repo's origin host, and the PR opens on
      // that host's API (github.com, GHES, or a ghe.com tenant).
      const { token, host } = yield* resolveGitHubTokenForRepo(repoPath, "creating a pull request", {
        callsApi: true,
      })
      // sendLog is threaded in as the progress sink so each line is emitted
      // when its step actually runs, not all at once before the work starts.
      return yield* createPullRequest(token, { ...buildPrParams(params, repoPath), host }, sendLog)
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
      // The MR targets the repo's own GitLab instance, which createMergeRequest
      // derives from the repo's remote URL — the token must belong to it.
      const token = yield* resolveGitLabTokenForRepo(repoPath, "creating a merge request")
      return yield* createMergeRequest(token, buildPrParams(params, repoPath), sendLog)
    })

    return respondToGitPrExit(event, await runtime.runPromiseExit(program), params.headBranch)
  })

  ipcMain.handle(
    "git:delete-branch",
    async (_event, params: { worktreePath: string; branch: string }) => {
      return runAndUnwrap(
        Effect.gen(function* () {
          const repoPath = yield* validateSessionPath(params.worktreePath)
          yield* deleteBranch(repoPath, params.branch)
          return { ok: true as const }
        }),
      )
    },
  )
}
