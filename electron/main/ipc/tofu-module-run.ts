/**
 * IPC handlers for a <TofuModule> block's Code and Apply tabs: the Terragrunt
 * code the module's template renders with the block's inputs, and a plan and
 * apply of it, streamed to the block as it runs.
 *
 * Each block gets a workspace in the session's `.runbooks/tofu-module/<id>/`:
 * a root.hcl that keeps state beside the unit, and the unit itself. In
 * simulation mode, simulation.yml answers instead of Terragrunt.
 */
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Effect } from "effect"
import { ipcMain, type WebContents } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { activeSimulationScenario, simulationEnabled } from "./simulation.ts"
import { BoilerplateRenderer } from "../../../src/services/BoilerplateRenderer.ts"
import { TofuModuleError } from "../../../src/errors/index.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import { isRemoteSource } from "../../../src/remote-source.ts"
import { loadModule } from "../../../src/domain/tofu-module/load.ts"
import {
  appliedResources,
  moduleOutputs,
  plannedResources,
  uiEvents,
  type ApplyResult,
  type PlanResult,
  type ResourceAction,
  type RunEvent,
} from "../../../src/domain/tofu-module/run.ts"
import {
  simulatedApplied,
  simulatedOutputs,
  simulatedPlan,
  simulatedResources,
  SIMULATION_FILE,
  type SimulatedModule,
} from "../../../src/domain/tofu-module/simulation.ts"
import { ROOT_HCL, unitFolder, type UnitFile } from "../../../src/domain/tofu-module/unit.ts"
import type { TofuModuleRenderRequest, TofuModuleRunRequest } from "../../shared/channels.ts"

/** The folder holding a module's template for its Terragrunt code. */
const TEMPLATE_DIR = ".boilerplate"
/** Where a plan is saved between the Plan and Apply steps, in Terragrunt's working directory. */
const PLAN_FILE = "runbooks.tfplan"
const TERRAGRUNT_INSTALL = "https://terragrunt.gruntwork.io/docs/getting-started/install/"

/** Runs that can be cancelled, by run id. */
const activeRuns = new Map<string, AbortController>()

export const fail = (message: string) => new TofuModuleError({ message })

const moduleDir = (source: string) =>
  Effect.gen(function* () {
    if (isRemoteSource(source)) {
      return yield* fail(
        "Reading a module from a URL isn't supported yet. Use a path to a local copy.",
      )
    }
    return yield* validateSessionPath(source)
  })

/** The block's Terragrunt code: the module's template rendered with its inputs, and a root.hcl. */
export const renderUnit = (source: string, blockId: string, values: Record<string, unknown>) =>
  Effect.gen(function* () {
    const dir = yield* moduleDir(source)
    const templateDir = path.join(dir, TEMPLATE_DIR)
    const hasTemplate = yield* Effect.promise(() =>
      fs.stat(templateDir).then(
        (stat) => stat.isDirectory(),
        () => false,
      ),
    )
    if (!hasTemplate) {
      return yield* fail(
        `The module has no ${TEMPLATE_DIR} folder, the template for the Terragrunt code that uses it.`,
      )
    }
    const renderer = yield* BoilerplateRenderer
    const files = yield* Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "runbooks-tofu-module-"))),
      (tmp) =>
        Effect.gen(function* () {
          yield* renderer.renderTemplate(templateDir, tmp, { ...values, SourceUrl: dir })
          return yield* Effect.promise(() => readTree(tmp))
        }),
      (tmp) => Effect.promise(() => fs.rm(tmp, { recursive: true, force: true })),
    )
    const unit = unitFolder(blockId)
    return [
      { path: "root.hcl", content: ROOT_HCL },
      ...files.map((file) => ({ ...file, path: `${unit}/${file.path}` })),
    ] satisfies UnitFile[]
  })

/** Every file under `dir`, by its path relative to it, sorted. */
async function readTree(dir: string, prefix = ""): Promise<UnitFile[]> {
  const files: UnitFile[] = []
  for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await readTree(dir, rel)))
    else files.push({ path: rel, content: await fs.readFile(path.join(dir, rel), "utf8") })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** The block's workspace in the session, which holds its root.hcl and unit. */
const workspaceDir = (blockId: string) =>
  Effect.map(sessionManager.getSession(), (session) =>
    path.join(session.initialWorkDir, ".runbooks", "tofu-module", unitFolder(blockId)),
  )

/** Writes the block's files to its workspace. Returns the unit's folder, where Terragrunt runs. */
const writeWorkspace = (blockId: string, files: readonly UnitFile[]) =>
  Effect.gen(function* () {
    const workspace = yield* workspaceDir(blockId)
    yield* Effect.promise(async () => {
      for (const file of files) {
        const target = path.join(workspace, file.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, file.content)
      }
    })
    return path.join(workspace, unitFolder(blockId))
  })

/** A Terragrunt log line without its time, and its level. */
function terragruntLog(line: string): RunEvent | undefined {
  const plain = line.trimEnd()
  if (!plain.trim()) return undefined
  const match = /^\d\d:\d\d:\d\d\.\d+\s+(\w+)\s+(.*)$/.exec(plain)
  const level = match?.[1]
  return {
    kind: "log",
    line: match ? match[2]! : plain,
    ...(level === "ERROR" ? { level: "error" } : level === "WARN" ? { level: "warn" } : {}),
  }
}

interface TerragruntRun {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly signal: AbortSignal
  /** Called with each event from OpenTofu's `-json` output; without it, stdout is collected. */
  readonly onEvent?: (event: RunEvent) => void
  /** Called with Terragrunt's own log lines. */
  readonly onLog?: (event: RunEvent) => void
}

/** Runs Terragrunt, failing with its last error lines when it exits nonzero. Returns stdout. */
function terragrunt(args: readonly string[], run: TerragruntRun): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("terragrunt", [...args, "--non-interactive", "--no-color"], {
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
      const event = terragruntLog(line)
      if (!event) return
      if (event.kind === "log" && event.level === "error") errors.push(event.line)
      run.onLog?.(event)
    })
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          fail(
            `Runbooks runs the module with Terragrunt, which isn't on your PATH. Install it: ${TERRAGRUNT_INSTALL}`,
          ),
        )
      } else if (err.name === "AbortError") {
        reject(fail("Stopped."))
      } else {
        reject(fail(`Couldn't run Terragrunt: ${errorMessage(err)}`))
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
    send({ kind: "log", line: "Simulated: no Terragrunt runs, and nothing real changes." })
    send({ kind: "log", line: "tofu: Initializing provider plugins..." })
    yield* pause(answer.delayMs, signal)
    send({ kind: "step", step: "plan" })
    const plan = yield* Effect.try({
      try: () => simulatedPlan(answer, values),
      catch: (cause) => (cause instanceof TofuModuleError ? cause : fail(errorMessage(cause))),
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
      sender.send("tofu-module:event", { runId, event })
    }
  }
  const finish = () => {
    if (activeRuns.get(runId) === controller) activeRuns.delete(runId)
  }
  return { signal: controller.signal, send, finish }
}

export function registerTofuModuleRunHandlers(): void {
  ipcMain.handle("tofu-module:render", async (_event, params: TofuModuleRenderRequest) =>
    runtime.runPromise(
      Effect.map(renderUnit(params.source, params.blockId, params.values), (files) => ({ files })),
    ),
  )

  ipcMain.handle("tofu-module:plan", async (event, params: TofuModuleRunRequest) => {
    const run = startRun(event.sender, params.runId)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          if (simulationEnabled()) {
            const answer = yield* simulatedModule(params.blockId)
            return yield* simulatePlan(answer, params.values, run.send, run.signal)
          }
          const files = yield* renderUnit(params.source, params.blockId, params.values)
          const unit = yield* writeWorkspace(params.blockId, files)
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
              terragrunt(["plan", `-out=${PLAN_FILE}`, "-json"], {
                cwd: unit,
                env,
                signal: run.signal,
                onEvent,
                onLog: run.send,
              }),
            catch: (cause) =>
              cause instanceof TofuModuleError ? cause : fail(errorMessage(cause)),
          })
          const shown = yield* Effect.tryPromise({
            try: () =>
              terragrunt(["show", "-json", PLAN_FILE], { cwd: unit, env, signal: run.signal }),
            catch: (cause) =>
              cause instanceof TofuModuleError ? cause : fail(errorMessage(cause)),
          })
          return { resources: plannedResources(JSON.parse(shown)) } satisfies PlanResult
        }),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("tofu-module:apply", async (event, params: TofuModuleRunRequest) => {
    const run = startRun(event.sender, params.runId)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          const spec = yield* Effect.flatMap(moduleDir(params.source), loadModule)
          const order = spec.outputs.map((output) => output.name)
          const sensitive = new Set(spec.outputs.filter((o) => o.sensitive).map((o) => o.name))
          if (simulationEnabled()) {
            const answer = yield* simulatedModule(params.blockId)
            return yield* simulateApply(answer, params.values, sensitive, run.send, run.signal)
          }
          // The plan step wrote the workspace and saved the plan this applies.
          const unit = path.join(yield* workspaceDir(params.blockId), unitFolder(params.blockId))
          const { env } = yield* sessionManager.getExecContext()
          const quiet = { cwd: unit, env, signal: run.signal }
          const attempt = (args: string[], streamed: boolean) =>
            Effect.tryPromise({
              try: () =>
                terragrunt(
                  args,
                  streamed ? { ...quiet, onEvent: run.send, onLog: run.send } : quiet,
                ),
              catch: (cause) =>
                cause instanceof TofuModuleError ? cause : fail(errorMessage(cause)),
            })
          run.send({ kind: "step", step: "apply" })
          yield* attempt(["apply", "-json", PLAN_FILE], true)
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

  ipcMain.handle("tofu-module:cancel", (_event, params: { runId: string }) => {
    activeRuns.get(params.runId)?.abort()
    activeRuns.delete(params.runId)
    return { ok: true as const }
  })
}
