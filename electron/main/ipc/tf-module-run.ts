/**
 * IPC handlers for a <TfModule> block's Code and Apply tabs: the code the
 * runbook's template renders with the block's inputs to use the module, and a
 * plan and apply of it, streamed to the block as it runs.
 *
 * The code is a Terragrunt unit when the template renders a terragrunt.hcl,
 * and plain OpenTofu or Terraform code otherwise. Each block gets a workspace
 * in the session's `.runbooks/tf-module/<id>/`, which holds its saved plan and
 * what the run downloads. A Terragrunt unit runs in the repository's checkout,
 * under its own root.hcl, when there is one, and otherwise in the workspace
 * beside a root.hcl that keeps state with it. Plain code always runs in the
 * workspace, so a local state file never lands in the repository. In
 * simulation mode, simulation.yml answers instead.
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
import { TfModuleError } from "../../../src/errors/index.ts"
import { describeFailure } from "./ipc-error.ts"
import { isRemoteSource } from "../../../src/remote-source.ts"
import { filesAtBase } from "../../../src/domain/tf-module/repoFiles.ts"
import { alignAttributes, isHclFile } from "../../../src/domain/tf-module/hclFormat.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import {
  appliedResources,
  commandLine,
  inputsKey,
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
  simulatedRepository,
  simulatedResources,
  SIMULATION_FILE,
  type SimulatedModule,
} from "../../../src/domain/tf-module/simulation.ts"
import {
  ancestorsOf,
  hasRootHcl,
  placeUnit,
  repoFolder,
  ROOT_HCL,
  toolFor,
  unitFolder,
  type CodeTool,
  type UnitFile,
} from "../../../src/domain/tf-module/unit.ts"
import type {
  TfModuleCode,
  TfModuleCodeRef,
  TfModuleRenderRequest,
  TfModuleRepo,
  TfModuleRunRequest,
} from "../../shared/channels.ts"

/** Where a plan is saved between the Plan and Apply steps, in the block's workspace. */
const PLAN_FILE = "runbooks.tfplan"
export const TERRAGRUNT_INSTALL = "https://terragrunt.gruntwork.io/docs/getting-started/install/"
export const TOFU_INSTALL = "https://opentofu.org/docs/intro/install/"

/** Runs that can be cancelled, by run id. */
const activeRuns = new Map<string, AbortController>()

export const fail = (message: string) => new TfModuleError({ message })

const moduleDir = (source: string) =>
  Effect.gen(function* () {
    if (isRemoteSource(source)) {
      return yield* fail(
        "Reading a module from a URL isn't supported yet. Use a path to a local copy.",
      )
    }
    return yield* validateSessionPath(source)
  })

/**
 * The runbook's template rendered with the inputs and `ModuleSource`, where
 * the code finds the module; its files by path in the code's folder.
 */
const renderTemplate = (template: string, values: Record<string, unknown>, moduleSource: string) =>
  Effect.gen(function* () {
    if (isRemoteSource(template)) {
      return yield* fail(
        "Reading a template from a URL isn't supported yet. Use a folder beside the runbook.",
      )
    }
    const templateDir = yield* validateSessionPath(template)
    const hasTemplate = yield* Effect.promise(() =>
      fs.stat(templateDir).then(
        (stat) => stat.isDirectory(),
        () => false,
      ),
    )
    if (!hasTemplate) {
      return yield* fail(
        `There's no template folder at "${template}". The template prop names a Boilerplate template beside the runbook, for the code that uses the module.`,
      )
    }
    const renderer = yield* BoilerplateRenderer
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "runbooks-tf-module-"))),
      (tmp) =>
        Effect.gen(function* () {
          yield* renderer.renderTemplate(templateDir, tmp, {
            ...values,
            ModuleSource: moduleSource,
          })
          const files = yield* Effect.promise(() => readTree(tmp))
          return files.map((file) =>
            isHclFile(file.path) ? { ...file, content: alignAttributes(file.content) } : file,
          )
        }),
      (tmp) => Effect.promise(() => fs.rm(tmp, { recursive: true, force: true })),
    )
  })

/** The code in the block's workspace, in its folder there, beside a root.hcl for a Terragrunt unit. */
const inWorkspaceTree = (blockId: string, files: readonly UnitFile[], tool: CodeTool) => {
  const unit = unitFolder(blockId)
  const placed = files.map((file) => ({ ...file, path: `${unit}/${file.path}` }))
  return tool === "terragrunt" ? [{ path: "root.hcl", content: ROOT_HCL }, ...placed] : placed
}

/** The block's code for its workspace, pointing at the module's folder. */
export const renderUnit = (
  ref: TfModuleCodeRef,
  blockId: string,
  values: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const dir = yield* moduleDir(ref.source)
    const files = yield* renderTemplate(ref.template, values, dir)
    const tool = toolFor(files)
    return { files: inWorkspaceTree(blockId, files, tool), tool }
  })

/**
 * What the repository holds where the unit lands: the files the unit would
 * write, and the files in each folder above it. Read from the base branch's
 * commit, so the unit shows as added until it's merged even after a plan
 * writes it to the checkout; from the simulated repository when there's no
 * checkout.
 */
const existingFiles = (
  repo: TfModuleRepo,
  folder: string,
  rendered: readonly UnitFile[],
  values: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    if (!repo.worktreePath) {
      if (!simulationEnabled()) return new Map<string, string>()
      return simulatedRepository(yield* activeSimulationScenario, values)
    }
    const worktree = yield* validateSessionPath(repo.worktreePath)
    return yield* filesAtBase(
      worktree,
      repo.baseBranch,
      ancestorsOf(folder),
      rendered.map((file) => `${folder}/${file.path}`),
    )
  })

/**
 * The block's code as it lands in the repository: in its folder there,
 * pointing at the module's `source` from runbook_block.yml, among the files the
 * repository already holds around it.
 */
export const renderInRepo = (
  ref: TfModuleCodeRef,
  values: Record<string, unknown>,
  repo: TfModuleRepo,
) =>
  Effect.gen(function* () {
    const dir = yield* moduleDir(ref.source)
    const spec = yield* loadModule(dir)
    const folder = yield* Effect.try({
      try: () => repoFolder(repo.path),
      catch: (cause) => fail(describeFailure(cause)),
    })
    const rendered = yield* renderTemplate(ref.template, values, spec.source ?? dir)
    const tool = toolFor(rendered)
    const placed = placeUnit(folder, rendered, yield* existingFiles(repo, folder, rendered, values))
    // The .hcl files above are context only for a Terragrunt unit, which may include them.
    const files = tool === "terragrunt" ? placed : placed.filter((f) => f.status !== "context")
    return {
      kind: "repo",
      tool,
      folder,
      files,
      rootHcl: hasRootHcl(files),
      source: spec.source,
    } satisfies TfModuleCode
  })

/** The block's code, in the repository when it has one, otherwise in its workspace. */
const renderCode = (request: TfModuleRenderRequest) =>
  request.repo
    ? renderInRepo(request, request.values, request.repo)
    : Effect.map(renderUnit(request, request.blockId, request.values), (code): TfModuleCode => ({
        kind: "workspace",
        ...code,
      }))

/** The unit's own files in the repository's code, by path in the unit's folder. */
export function unitFilesOf(code: Extract<TfModuleCode, { kind: "repo" }>): UnitFile[] {
  return code.files
    .filter((file) => file.status !== "context")
    .map((file) => ({ path: file.path.slice(code.folder.length + 1), content: file.content }))
}

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

/**
 * The block's workspace in the session: its saved plan, what Terragrunt
 * downloads, and its code when there's no repository to run it in.
 */
const workspaceDir = (blockId: string) =>
  Effect.map(sessionManager.getSession(), (session) =>
    path.join(session.initialWorkDir, ".runbooks", "tf-module", unitFolder(blockId)),
  )

/** Writes files under `dir`, by their paths relative to it. */
const writeFiles = (dir: string, files: readonly UnitFile[]) =>
  Effect.tryPromise({
    try: async () => {
      for (const file of files) {
        const target = path.join(dir, file.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, file.content)
      }
    },
    catch: (cause) => fail(`Couldn't write the code: ${describeFailure(cause)}`),
  })

/** What runs a block's code, where, and where Terragrunt keeps what it downloads. */
interface RunLocation {
  readonly tool: CodeTool
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

/**
 * Writes the block's code where it runs. A Terragrunt unit runs in the
 * repository's checkout, so it includes the repository's own root.hcl, or in
 * the block's workspace beside one Runbooks writes, when there's no checkout
 * or it has no root.hcl. Plain OpenTofu or Terraform code runs in the
 * workspace. What the run downloads stays in the workspace, out of the
 * repository the pull request commits.
 */
const writeForRun = (request: TfModuleRenderRequest) =>
  Effect.gen(function* () {
    const workspace = yield* workspaceDir(request.blockId)
    // The plan is saved here, wherever the code runs.
    yield* Effect.promise(() => fs.mkdir(workspace, { recursive: true }))
    const downloadDir = path.join(workspace, ".terragrunt-cache")
    const inWorkspace = (files: readonly UnitFile[], tool: CodeTool) =>
      Effect.as(writeFiles(workspace, inWorkspaceTree(request.blockId, files, tool)), {
        tool,
        cwd: path.join(workspace, unitFolder(request.blockId)),
        downloadDir,
      } satisfies RunLocation)
    if (!request.repo?.worktreePath) {
      const dir = yield* moduleDir(request.source)
      const files = yield* renderTemplate(request.template, request.values, dir)
      return yield* inWorkspace(files, toolFor(files))
    }
    const worktree = yield* validateSessionPath(request.repo.worktreePath)
    const code = yield* renderInRepo(request, request.values, request.repo)
    const files = unitFilesOf(code)
    if (code.tool === "tofu" || !code.rootHcl) return yield* inWorkspace(files, code.tool)
    const cwd = path.join(worktree, code.folder)
    yield* writeFiles(cwd, files)
    return { tool: code.tool, cwd, downloadDir } satisfies RunLocation
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

/** Whether `name` is an executable file in a folder on `env`'s PATH. */
export async function onPath(name: string, env: Record<string, string>): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const ok = await fs.access(path.join(dir, name), fs.constants.X_OK).then(
      () => true,
      () => false,
    )
    if (ok) return true
  }
  return false
}

/** The command for plain code: OpenTofu, or Terraform when only it is installed. */
async function tofuCommand(env: Record<string, string>): Promise<string> {
  if (await onPath("tofu", env)) return "tofu"
  if (await onPath("terraform", env)) return "terraform"
  throw fail(
    `Runbooks runs this code with OpenTofu or Terraform, and neither is on your PATH. Install OpenTofu: ${TOFU_INSTALL}`,
  )
}

/** OpenTofu subcommands that would otherwise stop to ask for input. */
const ASKS_FOR_INPUT = new Set(["init", "plan", "apply"])

/**
 * Runs the tool for a block's code, failing with its last error lines when it
 * exits nonzero. Returns stdout. Terragrunt initializes as it goes; OpenTofu
 * needs an `init` first.
 */
async function runTool(tool: CodeTool, args: readonly string[], run: ToolRun): Promise<string> {
  if (tool === "terragrunt") {
    const flags = ["--non-interactive", "--no-color"]
    if (run.downloadDir) flags.push("--download-dir", run.downloadDir)
    return spawnTool("terragrunt", [...args, ...flags], run)
  }
  const command = await tofuCommand(run.env)
  const [sub, ...rest] = args
  const flags = ["-no-color", ...(ASKS_FOR_INPUT.has(sub!) ? ["-input=false"] : [])]
  return spawnTool(command, [sub!, ...flags, ...rest], run)
}

/** Runs one command for a block's code. Returns stdout. */
function spawnTool(command: string, args: readonly string[], run: ToolRun): Promise<string> {
  const name =
    command === "terragrunt" ? "Terragrunt" : command === "tofu" ? "OpenTofu" : "Terraform"
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
            command === "terragrunt"
              ? `Runbooks runs this Terragrunt unit with Terragrunt, which isn't on your PATH. Install it: ${TERRAGRUNT_INSTALL}`
              : `${name} isn't on your PATH. Install OpenTofu: ${TOFU_INSTALL}`,
          ),
        )
      } else if (err.name === "AbortError") {
        reject(fail("Stopped."))
      } else {
        reject(fail(`Couldn't run ${name}: ${describeFailure(err)}`))
      }
    })
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else if (code !== null) {
        reject(fail(errors.slice(-3).join(" ") || `${name} exited with code ${code}.`))
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
      sender.send("tf-module:event", { runId, event })
    }
  }
  const finish = () => {
    if (activeRuns.get(runId) === controller) activeRuns.delete(runId)
  }
  return { signal: controller.signal, send, finish }
}

export function registerTfModuleRunHandlers(): void {
  ipcMain.handle("tf-module:render", async (_event, params: TfModuleRenderRequest) =>
    runtime.runPromise(renderCode(params)),
  )

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
          if (location.tool === "tofu") {
            yield* Effect.tryPromise({
              try: () =>
                runTool("tofu", ["init"], {
                  ...where,
                  env,
                  signal: run.signal,
                  onEvent: run.send,
                  onLog: run.send,
                }),
              catch: (cause) =>
                cause instanceof TfModuleError ? cause : fail(describeFailure(cause)),
            })
          }
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
              runTool(location.tool, ["plan", `-out=${planFile}`, "-json"], {
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
              runTool(location.tool, ["show", "-json", planFile], {
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
                runTool(
                  location.tool,
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
