/**
 * The pull request a <TerragruntApplyWithGitHubPullRequest> block opens for a
 * <TfModule> block's code: its Terragrunt unit, committed
 * to a new branch of the repository a <GitClone> block cloned, pushed, opened
 * as a GitHub pull request, and merged when the user says.
 *
 * In simulation mode nothing touches git or GitHub; each step pauses and
 * answers as GitHub would.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { simulationEnabled } from "./simulation.ts"
import { resolveGitHubTokenForRepo } from "./git.ts"
import { fail, writeUnit } from "./tf-module-code.ts"
import { pause, startRun } from "./tf-module-run.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import { describeFailure } from "./ipc-error.ts"
import {
  checkOutRemoteBranch,
  createPullRequest,
  findOpenPullRequest,
  mergePullRequest,
  pushToPullRequest,
  updatePullRequest,
} from "../../../src/domain/git/operations.ts"
import type { RunEvent } from "../../../src/domain/tf-module/run.ts"
import type {
  TfModulePrMergeRequest,
  TfModulePrOpenRequest,
  TfModulePrPushRequest,
  TfModulePrTarget,
  TfModulePrUpdateRequest,
  TfModulePullRequestResult,
} from "../../shared/channels.ts"

/** How long each simulated step takes. */
const SIMULATED_STEP_MS = 500
/** The number a simulated pull request gets. */
const SIMULATED_NUMBER = 42

const asTfModuleError = (cause: unknown) =>
  cause instanceof TfModuleError ? cause : fail(describeFailure(cause))

/** Writes the block's unit to its folder in the checkout. Returns the paths it wrote. */
const writeUnitFor = (request: TfModulePrPushRequest, worktree: string) =>
  Effect.map(
    writeUnit(
      request,
      request.values,
      { path: request.path, baseBranch: request.target.baseBranch },
      worktree,
    ),
    ({ written }) => written,
  )

/** The repository's checkout, which must be one the session cloned or picked. */
const checkout = (target: TfModulePrTarget) =>
  target.worktreePath
    ? validateSessionPath(target.worktreePath)
    : Effect.fail(fail("Clone the repository with a <GitClone> block first."))

const simulatedUrl = (target: TfModulePrTarget, number: number) =>
  `https://github.com/${target.owner}/${target.repo}/pull/${number}`

export function registerTfModulePrHandlers(): void {
  ipcMain.handle("tf-module:pr-open", async (event, request: TfModulePrOpenRequest) => {
    const run = startRun(event.sender, request.runId)
    const log = (line: string) => run.send({ kind: "log", line } satisfies RunEvent)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          if (simulationEnabled()) {
            log("Simulated: nothing is pushed, and GitHub isn't called.")
            for (const step of [
              `Creating branch ${request.branch}…`,
              "Committing changes…",
              `Pushing ${request.branch} to origin…`,
              "Opening pull request…",
            ]) {
              log(step)
              yield* pause(SIMULATED_STEP_MS, run.signal)
            }
            return {
              url: simulatedUrl(request.target, SIMULATED_NUMBER),
              number: SIMULATED_NUMBER,
              branch: request.branch,
            } satisfies TfModulePullRequestResult
          }
          const worktree = yield* checkout(request.target)
          const { token, host } = yield* resolveGitHubTokenForRepo(
            worktree,
            "opening a pull request",
            { callsApi: true },
          )
          const repo = { owner: request.target.owner, repo: request.target.repo, host }
          // A pull request this branch already has, such as one opened before
          // the app restarted, gets the code as a new commit rather than a
          // second pull request, which a push from the base branch can't make.
          const existing = yield* findOpenPullRequest(token, {
            ...repo,
            headBranch: request.branch,
          })
          if (existing) {
            log(`#${existing.number} is already open for ${request.branch}; updating it.`)
            yield* checkOutRemoteBranch(token, worktree, request.branch)
            const written = yield* writeUnitFor(request, worktree)
            log(`Wrote ${written.join(", ")}`)
            yield* pushToPullRequest(
              token,
              {
                ...repo,
                title: request.title,
                baseBranch: request.target.baseBranch,
                headBranch: request.branch,
                commitMessage: request.commitMessage,
                repoPath: worktree,
              },
              log,
            )
            yield* updatePullRequest(token, {
              ...repo,
              number: existing.number,
              title: request.title,
              body: request.body,
            })
            log(`Updated ${existing.url}`)
            return { url: existing.url, number: existing.number, branch: existing.branch }
          }
          const written = yield* writeUnitFor(request, worktree)
          log(`Wrote ${written.join(", ")}`)
          const pr = yield* createPullRequest(
            token,
            {
              owner: request.target.owner,
              repo: request.target.repo,
              title: request.title,
              body: request.body,
              baseBranch: request.target.baseBranch,
              headBranch: request.branch,
              commitMessage: request.commitMessage,
              repoPath: worktree,
              host,
            },
            log,
          )
          log(`Opened ${pr.url}`)
          return { url: pr.url, number: pr.number, branch: pr.branch }
        }).pipe(Effect.mapError(asTfModuleError)),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tf-module:pr-push", async (event, request: TfModulePrPushRequest) => {
    const run = startRun(event.sender, request.runId)
    const log = (line: string) => run.send({ kind: "log", line } satisfies RunEvent)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          if (simulationEnabled()) {
            for (const step of ["Committing changes…", `Pushing ${request.branch} to origin…`]) {
              log(step)
              yield* pause(SIMULATED_STEP_MS, run.signal)
            }
            return { ok: true as const }
          }
          const worktree = yield* checkout(request.target)
          const written = yield* writeUnitFor(request, worktree)
          log(`Wrote ${written.join(", ")}`)
          const { token, host } = yield* resolveGitHubTokenForRepo(worktree, "pushing", {
            callsApi: true,
          })
          yield* pushToPullRequest(
            token,
            {
              owner: request.target.owner,
              repo: request.target.repo,
              title: request.title,
              baseBranch: request.target.baseBranch,
              headBranch: request.branch,
              commitMessage: request.commitMessage,
              repoPath: worktree,
              host,
            },
            log,
          )
          log("Pushed.")
          return { ok: true as const }
        }).pipe(Effect.mapError(asTfModuleError)),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tf-module:pr-update", async (event, request: TfModulePrUpdateRequest) => {
    const run = startRun(event.sender, request.runId)
    const log = (line: string) => run.send({ kind: "log", line } satisfies RunEvent)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          log(`Updating the title and description of #${request.number}…`)
          if (simulationEnabled()) {
            yield* pause(SIMULATED_STEP_MS, run.signal)
            log("Updated.")
            return { ok: true as const }
          }
          const worktree = yield* checkout(request.target)
          const { token, host } = yield* resolveGitHubTokenForRepo(
            worktree,
            "updating a pull request",
            { callsApi: true },
          )
          yield* updatePullRequest(token, {
            owner: request.target.owner,
            repo: request.target.repo,
            number: request.number,
            title: request.title,
            body: request.body,
            host,
          })
          log("Updated.")
          return { ok: true as const }
        }).pipe(Effect.mapError(asTfModuleError)),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tf-module:pr-merge", async (event, request: TfModulePrMergeRequest) => {
    const run = startRun(event.sender, request.runId)
    const log = (line: string) => run.send({ kind: "log", line } satisfies RunEvent)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          log(`Merging #${request.number} into ${request.target.baseBranch}…`)
          if (simulationEnabled()) {
            yield* pause(SIMULATED_STEP_MS * 2, run.signal)
            log("Merged.")
            return { sha: "0000000" }
          }
          const worktree = yield* checkout(request.target)
          const { token, host } = yield* resolveGitHubTokenForRepo(
            worktree,
            "merging a pull request",
            { callsApi: true },
          )
          const merged = yield* mergePullRequest(token, {
            owner: request.target.owner,
            repo: request.target.repo,
            number: request.number,
            method: request.method,
            host,
          })
          log(`Merged as ${merged.sha.slice(0, 7)}.`)
          return merged
        }).pipe(Effect.mapError(asTfModuleError)),
      )
    } finally {
      run.finish()
    }
  })
}
