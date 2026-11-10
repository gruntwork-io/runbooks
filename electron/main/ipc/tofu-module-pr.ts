/**
 * The pull request a <TofuModule> block opens: its Terragrunt unit, committed
 * to a new branch of the repository a <GitClone> block cloned, pushed, opened
 * as a GitHub pull request, and merged when the user says.
 *
 * In simulation mode nothing touches git or GitHub; each step pauses and
 * answers as GitHub would.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { simulationEnabled } from "./simulation.ts"
import { resolveGitHubTokenForRepo } from "./git.ts"
import { fail, pause, renderUnit, startRun } from "./tofu-module-run.ts"
import { TofuModuleError } from "../../../src/errors/index.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import {
  createPullRequest,
  mergePullRequest,
  pushToPullRequest,
} from "../../../src/domain/git/operations.ts"
import { unitFolder } from "../../../src/domain/tofu-module/unit.ts"
import type { RunEvent } from "../../../src/domain/tofu-module/run.ts"
import type {
  TofuModulePrMergeRequest,
  TofuModulePrOpenRequest,
  TofuModulePrPushRequest,
  TofuModulePrTarget,
  TofuModulePullRequestResult,
} from "../../shared/channels.ts"

/** How long each simulated step takes. */
const SIMULATED_STEP_MS = 500
/** The number a simulated pull request gets. */
const SIMULATED_NUMBER = 42

const asTofuError = (cause: unknown) =>
  cause instanceof TofuModuleError ? cause : fail(errorMessage(cause))

/** A path inside the repository: relative, with no part that climbs out of it. */
function repoPath(given: string): string {
  const normalized = path.posix.normalize(given.trim().replace(/\\/g, "/")).replace(/\/+$/, "")
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized)) {
    throw fail(`"${given}" isn't a folder inside the repository.`)
  }
  if (normalized.split("/").includes("..")) {
    throw fail(`"${given}" leaves the repository. Use a folder inside it.`)
  }
  return normalized
}

/** Writes the block's unit, its rendered Terragrunt files without root.hcl, to `dir` in the repo. */
const writeUnit = (request: TofuModulePrPushRequest, worktree: string) =>
  Effect.gen(function* () {
    const dir = yield* Effect.try({ try: () => repoPath(request.path), catch: asTofuError })
    const prefix = `${unitFolder(request.blockId)}/`
    const files = (yield* renderUnit(request.source, request.blockId, request.values)).filter(
      (file) => file.path.startsWith(prefix),
    )
    yield* Effect.tryPromise({
      try: async () => {
        for (const file of files) {
          const target = path.join(worktree, dir, file.path.slice(prefix.length))
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, file.content)
        }
      },
      catch: asTofuError,
    })
    return files.map((file) => `${dir}/${file.path.slice(prefix.length)}`)
  })

/** The repository's checkout, which must be one the session cloned or picked. */
const checkout = (target: TofuModulePrTarget) =>
  target.worktreePath
    ? validateSessionPath(target.worktreePath)
    : Effect.fail(fail("Clone the repository with a <GitClone> block first."))

const simulatedUrl = (target: TofuModulePrTarget, number: number) =>
  `https://github.com/${target.owner}/${target.repo}/pull/${number}`

export function registerTofuModulePrHandlers(): void {
  ipcMain.handle("tofu-module:pr-open", async (event, request: TofuModulePrOpenRequest) => {
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
            } satisfies TofuModulePullRequestResult
          }
          const worktree = yield* checkout(request.target)
          const written = yield* writeUnit(request, worktree)
          log(`Wrote ${written.join(", ")}`)
          const { token, host } = yield* resolveGitHubTokenForRepo(
            worktree,
            "opening a pull request",
            { callsApi: true },
          )
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
        }).pipe(Effect.mapError(asTofuError)),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tofu-module:pr-push", async (event, request: TofuModulePrPushRequest) => {
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
          const written = yield* writeUnit(request, worktree)
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
        }).pipe(Effect.mapError(asTofuError)),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tofu-module:pr-merge", async (event, request: TofuModulePrMergeRequest) => {
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
        }).pipe(Effect.mapError(asTofuError)),
      )
    } finally {
      run.finish()
    }
  })
}
