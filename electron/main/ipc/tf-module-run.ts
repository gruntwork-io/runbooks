/**
 * IPC handlers for the plan and apply of a <TfModule> block's code, for a
 * <TerragruntApplyWithGitHubPullRequest> block's Apply tab, streamed as they run.
 *
 * Only a Terragrunt unit, code whose template renders a terragrunt.hcl,
 * plans and applies. Each block gets a workspace in the session's
 * `.runbooks/tf-module/<id>/`, which holds its saved plan and what the run
 * downloads. The unit runs in the repository's checkout, under its own
 * root.hcl, when there is one, and otherwise in the workspace beside a
 * root.hcl that keeps state with it. In simulation mode, simulation.yml
 * answers instead.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Effect } from "effect"
import { ipcMain, type WebContents } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { moduleDir } from "./tf-module-source.ts"
import { activeSimulationScenario, simulationEnabled } from "./simulation.ts"
import {
  fail,
  inWorkspaceTree,
  renderInRepo,
  renderTemplate,
  unitFilesOf,
  writeFiles,
} from "./tf-module-code.ts"
import { TERRAGRUNT_INSTALL } from "./tf-module-ready.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import { describeFailure } from "./ipc-error.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import {
  appliedResources,
  commandLine,
  moduleOutputs,
  plannedResources,
  uiEvents,
  type ApplyResult,
  type PlanResult,
  type ResourceAction,
  type RunEvent,
} from "../../../src/domain/tf-module/run.ts"
import {
  simulatedApplied,
  simulatedOutputs,
  simulatedPlan,
  simulatedResources,
  SIMULATION_FILE,
  type SimulatedModule,
} from "../../../src/domain/tf-module/simulation.ts"
import { inputsKey } from "../../../src/domain/tf-module/inputsKey.ts"
import { toolFor, unitFolder, type UnitFile } from "../../../src/domain/tf-module/unit.ts"
import type { TfModuleRenderRequest, TfModuleRunRequest } from "../../shared/channels.ts"

/** Where a plan is saved between the Plan and Apply steps, in the block's workspace. */
const PLAN_FILE = "runbooks.tfplan"

/** Runs that can be cancelled, by run id. */
const activeRuns = new Map<string, AbortController>()

/**
 * The block's workspace in the session: its saved plan, what Terragrunt
 * downloads, and its code when there's no repository to run it in.
 */
const workspaceDir = (blockId: string) =>
  Effect.map(sessionManager.getSession(), (session) =>
    path.join(session.initialWorkDir, ".runbooks", "tf-module", unitFolder(blockId)),
  )

/** Where a block's unit runs, and where Terragrunt keeps what it downloads. */
interface RunLocation {
  readonly cwd: string
  readonly downloadDir: string
}

/**
 * Each block's saved plan, by block id: where it ran, so the apply runs in
 * the same place, and the inputs it was made for, so an apply never applies
 * a plan for other inputs. A new plan replaces it, and an apply uses it up.
 */
interface SavedPlan {
  /** None for a simulated plan, which runs nowhere. */
  readonly location?: RunLocation | undefined
  readonly inputs: string
}
const savedPlans = new Map<string, SavedPlan>()

/** The block's saved plan for these inputs, or an error saying what to do instead. */
const planToApply = (blockId: string, values: Record<string, unknown>) => {
  const saved = savedPlans.get(blockId)
  if (!saved) return Effect.fail(fail("Plan first, so there's a plan to apply."))
  if (saved.inputs !== inputsKey(values)) {
    return Effect.fail(fail("The inputs changed since the plan. Plan again to apply them."))
  }
  savedPlans.delete(blockId)
  return Effect.succeed(saved)
}

const notAUnit = Effect.fail(
  fail(
    "This code isn't a Terragrunt unit: the template renders no terragrunt.hcl. Runbooks plans and applies Terragrunt units only.",
  ),
)

/**
 * Writes the block's unit where it runs: in the repository's checkout, so it
 * includes the repository's own root.hcl, or in the block's workspace beside
 * one Runbooks writes, when there's no checkout or it has no root.hcl. What
 * the run downloads stays in the workspace, out of the repository the pull
 * request commits.
 */
const writeForRun = (request: TfModuleRenderRequest) =>
  Effect.gen(function* () {
    const workspace = yield* workspaceDir(request.blockId)
    // The plan is saved here, wherever the code runs.
    yield* Effect.promise(() => fs.mkdir(workspace, { recursive: true }))
    const downloadDir = path.join(workspace, ".terragrunt-cache")
    const inWorkspace = (files: readonly UnitFile[]) =>
      Effect.as(writeFiles(workspace, inWorkspaceTree(request.blockId, files, "terragrunt")), {
        cwd: path.join(workspace, unitFolder(request.blockId)),
        downloadDir,
      } satisfies RunLocation)
    if (!request.repo?.worktreePath) {
      const dir = yield* moduleDir(request.source)
      const files = yield* renderTemplate(request.template, request.values, dir)
      if (toolFor(files) !== "terragrunt") return yield* notAUnit
      return yield* inWorkspace(files)
    }
    const worktree = yield* validateSessionPath(request.repo.worktreePath)
    const code = yield* renderInRepo(request, request.values, request.repo)
    if (code.tool !== "terragrunt") return yield* notAUnit
    const files = unitFilesOf(code)
    if (!code.rootHcl) return yield* inWorkspace(files)
    const cwd = path.join(worktree, code.folder)
    yield* writeFiles(cwd, files)
    return { cwd, downloadDir } satisfies RunLocation
  })

/** A Terragrunt or OpenTofu log line without its time, and its level. */
function toolLog(line: string): RunEvent | undefined {
  const plain = line.trimEnd()
  if (!plain.trim()) return undefined
  const match = /^\d\d:\d\d:\d\d\.\d+\s+(\w+)\s+(.*)$/.exec(plain)
  // OpenTofu's own errors have no level, only an "Error:" heading.
  const level = match?.[1] ?? (/^[\s│╷]*Error:/.test(plain) ? "ERROR" : undefined)
  return {
    kind: "log",
    line: match ? match[2]! : plain,
    ...(level === "ERROR" ? { level: "error" } : level === "WARN" ? { level: "warn" } : {}),
  }
}

interface ToolRun {
  readonly cwd: string
  /** Where Terragrunt downloads the module and runs OpenTofu. */
  readonly downloadDir?: string
  readonly env: Record<string, string>
  readonly signal: AbortSignal
  /** Called with each event from OpenTofu's `-json` output; without it, stdout is collected. */
  readonly onEvent?: (event: RunEvent) => void
  /** Called with the tool's own log lines. */
  readonly onLog?: (event: RunEvent) => void
}

/**
 * Runs Terragrunt for a block's unit, failing with its last error lines when
 * it exits nonzero. Returns stdout. Terragrunt initializes as it goes.
 */
function runTerragrunt(subcommand: readonly string[], run: ToolRun): Promise<string> {
  const command = "terragrunt"
  const args = [...subcommand, "--non-interactive", "--no-color"]
  if (run.downloadDir) args.push("--download-dir", run.downloadDir)
  // The command first, so a run that prints nothing for a while still shows
  // what it's waiting on, in a form that can be run again in a terminal.
  run.onLog?.({ kind: "log", line: commandLine(run.cwd, command, args) })
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: run.cwd,
      env: run.env,
      signal: run.signal,
    })
    let stdout = ""
    const errors: string[] = []
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!run.onEvent) {
        stdout += `${line}\n`
        return
      }
      for (const event of uiEvents(line)) {
        if (event.kind === "log" && event.level === "error") errors.push(event.line)
        run.onEvent(event)
      }
    })
    createInterface({ input: child.stderr }).on("line", (line) => {
      const event = toolLog(line)
      if (!event) return
      if (event.kind === "log" && event.level === "error") errors.push(event.line)
      run.onLog?.(event)
    })
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          fail(
            `Runbooks runs this Terragrunt unit with Terragrunt, which isn't on your PATH. Install it: ${TERRAGRUNT_INSTALL}`,
          ),
        )
      } else if (err.name === "AbortError") {
        reject(fail("Stopped."))
      } else {
        reject(fail(`Couldn't run Terragrunt: ${describeFailure(err)}`))
      }
    })
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else if (code !== null) {
        reject(fail(errors.slice(-3).join(" ") || `Terragrunt exited with code ${code}.`))
      }
    })
  })
}

/** The answers the active simulation scenario gives for a block, or an error saying what to add. */
const simulatedModule = (blockId: string) =>
  Effect.gen(function* () {
    const scenario = yield* activeSimulationScenario
    const answer = scenario.modules[blockId]
    if (!answer) {
      return yield* fail(
        `Simulation: scenario "${scenario.name}" in ${SIMULATION_FILE} has no answer for this block's plan and apply. Add one under modules.${blockId}.`,
      )
    }
    return answer
  })

export const pause = (ms: number, signal: AbortSignal) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        })
      }),
  ).pipe(Effect.flatMap(() => (signal.aborted ? Effect.fail(fail("Stopped.")) : Effect.void)))

/** OpenTofu's counts of a plan's actions: a replace adds one and destroys one. */
function countActions(actions: readonly ResourceAction[]) {
  const count = (...of: ResourceAction[]) => actions.filter((a) => of.includes(a)).length
  return {
    add: count("create", "replace"),
    change: count("update"),
    destroy: count("delete", "replace"),
  }
}

/** What OpenTofu logs as it starts and finishes each action. */
const APPLY_WORDS: Record<ResourceAction, { start: string; done: string }> = {
  create: { start: "Creating...", done: "Creation complete" },
  update: { start: "Modifying...", done: "Modifications complete" },
  replace: { start: "Replacing...", done: "Creation complete" },
  delete: { start: "Destroying...", done: "Destruction complete" },
}

function simulatePlan(
  answer: SimulatedModule,
  values: Record<string, unknown>,
  send: (event: RunEvent) => void,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    send({ kind: "step", step: "init" })
    send({ kind: "log", line: "Simulated: nothing runs, and nothing real changes." })
    send({ kind: "log", line: "tofu: Initializing provider plugins..." })
    yield* pause(answer.delayMs, signal)
    send({ kind: "step", step: "plan" })
    const plan = yield* Effect.try({
      try: () => simulatedPlan(answer, values),
      catch: (cause) => (cause instanceof TfModuleError ? cause : fail(describeFailure(cause))),
    })
    for (const resource of plan.resources) {
      send({ kind: "log", line: `${resource.address}: Plan to ${resource.action}` })
    }
    yield* pause(answer.delayMs, signal)
    const n = countActions(plan.resources.map((r) => r.action))
    send({
      kind: "log",
      line: `Plan: ${n.add} to add, ${n.change} to change, ${n.destroy} to destroy.`,
    })
    return plan
  })
}

function simulateApply(
  answer: SimulatedModule,
  values: Record<string, unknown>,
  sensitive: ReadonlySet<string>,
  send: (event: RunEvent) => void,
  signal: AbortSignal,
) {
  return Effect.gen(function* () {
    send({ kind: "step", step: "apply" })
    const resources = simulatedResources(answer, values)
    for (const [index, { address, resource }] of resources.entries()) {
      const words = APPLY_WORDS[resource.action]
      send({ kind: "resource", address, progress: "working" })
      send({ kind: "log", line: `${address}: ${words.start}` })
      yield* pause(answer.delayMs, signal)
      if (answer.applyError && index === resources.length - 1) {
        send({ kind: "resource", address, progress: "failed", message: answer.applyError })
        send({ kind: "log", line: answer.applyError, level: "error" })
        return yield* fail(answer.applyError)
      }
      send({ kind: "resource", address, progress: "done", elapsedSeconds: answer.delayMs / 1000 })
      send({ kind: "log", line: `${address}: ${words.done}` })
    }
    const n = countActions(resources.map((r) => r.resource.action))
    send({
      kind: "log",
      line: `Apply complete! Resources: ${n.add} added, ${n.change} changed, ${n.destroy} destroyed.`,
    })
    return {
      resources: resources
        .filter(({ resource }) => resource.action !== "delete")
        .map(({ address, row, resource }) => simulatedApplied(address, row, resource)),
      outputs: simulatedOutputs(answer, values, sensitive),
    } satisfies ApplyResult
  })
}

/** Starts a cancellable run that streams its events to the block. */
export function startRun(sender: WebContents, runId: string) {
  activeRuns.get(runId)?.abort()
  const controller = new AbortController()
  activeRuns.set(runId, controller)
  const send = (event: RunEvent) => {
    if (!controller.signal.aborted && !sender.isDestroyed()) {
      sender.send("tf-module:event", { runId, event, at: new Date().toISOString() })
    }
  }
  const finish = () => {
    if (activeRuns.get(runId) === controller) activeRuns.delete(runId)
  }
  return { signal: controller.signal, send, finish }
}

export function registerTfModuleRunHandlers(): void {
  ipcMain.handle("tf-module:plan", async (event, params: TfModuleRunRequest) => {
    const run = startRun(event.sender, params.runId)
    // Until this plan finishes, there's no plan to apply.
    savedPlans.delete(params.blockId)
    const inputs = inputsKey(params.values)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          if (simulationEnabled()) {
            const answer = yield* simulatedModule(params.blockId)
            const plan = yield* simulatePlan(answer, params.values, run.send, run.signal)
            savedPlans.set(params.blockId, { inputs })
            return plan
          }
          const location = yield* writeForRun(params)
          const planFile = path.join(yield* workspaceDir(params.blockId), PLAN_FILE)
          const where = { cwd: location.cwd, downloadDir: location.downloadDir }
          const { env } = yield* sessionManager.getExecContext()
          run.send({ kind: "step", step: "init" })
          let planning = false
          const onEvent = (e: RunEvent) => {
            if (!planning) {
              planning = true
              run.send({ kind: "step", step: "plan" })
            }
            run.send(e)
          }
          yield* Effect.tryPromise({
            try: () =>
              runTerragrunt(["plan", `-out=${planFile}`, "-json"], {
                ...where,
                env,
                signal: run.signal,
                onEvent,
                onLog: run.send,
              }),
            catch: (cause) =>
              cause instanceof TfModuleError ? cause : fail(describeFailure(cause)),
          })
          const shown = yield* Effect.tryPromise({
            try: () =>
              runTerragrunt(["show", "-json", planFile], {
                ...where,
                env,
                signal: run.signal,
              }),
            catch: (cause) =>
              cause instanceof TfModuleError ? cause : fail(describeFailure(cause)),
          })
          savedPlans.set(params.blockId, { location, inputs })
          return { resources: plannedResources(JSON.parse(shown)) } satisfies PlanResult
        }),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tf-module:apply", async (event, params: TfModuleRunRequest) => {
    const run = startRun(event.sender, params.runId)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          const spec = yield* Effect.flatMap(moduleDir(params.source), loadModule)
          const order = spec.outputs.map((output) => output.name)
          const sensitive = new Set(spec.outputs.filter((o) => o.sensitive).map((o) => o.name))
          const { location } = yield* planToApply(params.blockId, params.values)
          if (simulationEnabled()) {
            const answer = yield* simulatedModule(params.blockId)
            return yield* simulateApply(answer, params.values, sensitive, run.send, run.signal)
          }
          if (!location) return yield* fail("Plan first, so there's a plan to apply.")
          // The plan step wrote the code, and saved the plan this applies, in the workspace.
          const workspace = yield* workspaceDir(params.blockId)
          const planFile = path.join(workspace, PLAN_FILE)
          const { env } = yield* sessionManager.getExecContext()
          const quiet = {
            cwd: location.cwd,
            downloadDir: location.downloadDir,
            env,
            signal: run.signal,
          }
          const attempt = (args: string[], streamed: boolean) =>
            Effect.tryPromise({
              try: () =>
                runTerragrunt(
                  args,
                  streamed ? { ...quiet, onEvent: run.send, onLog: run.send } : quiet,
                ),
              catch: (cause) =>
                cause instanceof TfModuleError ? cause : fail(describeFailure(cause)),
            })
          run.send({ kind: "step", step: "apply" })
          yield* attempt(["apply", "-json", planFile], true)
          run.send({ kind: "step", step: "read" })
          const state = yield* attempt(["show", "-json"], false)
          const outputs = yield* attempt(["output", "-json"], false)
          return {
            resources: appliedResources(JSON.parse(state)),
            outputs: moduleOutputs(JSON.parse(outputs), order),
          } satisfies ApplyResult
        }),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tf-module:cancel", (_event, params: { runId: string }) => {
    activeRuns.get(params.runId)?.abort()
    activeRuns.delete(params.runId)
    return { ok: true as const }
  })
}
