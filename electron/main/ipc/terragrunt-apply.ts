/**
 * IPC handlers for a <TerragruntApply> block: its preflight, and the plan and
 * apply of one Terragrunt unit in a clone, streamed as they run.
 *
 * Nothing is applied that isn't pushed, so the preflight and the plan refuse
 * a clone with changes that aren't on its remote. The saved plan, which can
 * hold secrets, and what Terragrunt downloads stay in a folder outside the
 * clone, and the plan is deleted once it's applied. A plan is applied only
 * while the unit's files, and the .hcl files above it, are as they were. In
 * simulation mode, simulation.yml answers instead (see terragrunt-simulate.ts).
 */
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, type ManagedRuntime } from "effect"
import { ipcMain, type WebContents } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { moduleDir } from "./tf-module-source.ts"
import { describeFailure } from "./ipc-error.ts"
import { simulationEnabled } from "./simulation.ts"
import { simulateApply, simulatedPreflight, simulatePlan } from "./terragrunt-simulate.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import { isRemoteSource } from "../../../src/remote-source.ts"
import { disallowedEnvVars } from "../../../src/domain/exec/authEnv.ts"
import { gitLines } from "../../../src/domain/tf-module/git.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import { renderedUnit } from "../../../src/domain/terragrunt/render.ts"
import {
  runTerragrunt,
  TERRAGRUNT_INSTALL,
  type ToolRun,
} from "../../../src/domain/terragrunt/terragrunt.ts"
import {
  appliedResources,
  moduleOutputs,
  plannedResources,
  type ApplyResult,
  type PlanResult,
  type RunEvent,
} from "../../../src/domain/terragrunt/run.ts"
import type {
  TerragruntApplyRequest,
  TerragruntPreflight,
  TerragruntRunRequest,
  ToolStatus,
} from "../../shared/channels.ts"

const fail = (message: string) => new TfModuleError({ message })

const TOFU_INSTALL = "https://opentofu.org/docs/intro/install/"

/** The lock file a plan writes beside the unit, which is pushed with the next change. */
const LOCK_FILE = ".terraform.lock.hcl"

/** Folders in a unit that Terragrunt and OpenTofu write, which aren't the unit's code. */
const WORK_FOLDERS = new Set([".terragrunt-cache", ".terraform"])

/**
 * Each block's plan or apply while it runs, by block id. A block runs one at
 * a time, so a plan never starts in a unit that's being applied, and an
 * apply never starts while its plan is being replaced. `done` settles once
 * Terragrunt has exited.
 */
interface BlockRun {
  readonly runId: string
  readonly kind: "plan" | "apply"
  readonly controller: AbortController
  readonly done: Promise<unknown>
}
const blockRuns = new Map<string, BlockRun>()

/** Whether a block is planning or applying a unit. */
export function isTerragruntRunning(): boolean {
  return blockRuns.size > 0
}

/**
 * Stops every plan and apply, and waits until Terragrunt has exited, or
 * been killed. Called on quit and before switching sessions: Terragrunt runs
 * in its own process group, so nothing else stops it.
 */
export async function stopTerragruntRuns(): Promise<void> {
  const runs = [...blockRuns.values()]
  for (const run of runs) run.controller.abort()
  await Promise.allSettled(runs.map((run) => run.done))
}

/** Removes every block's folder outside its clone: saved plans and downloads. Called on quit. */
export async function removeTerragruntWorkFolders(): Promise<void> {
  const folders = await Promise.allSettled(workFolders.values())
  workFolders.clear()
  savedPlans.clear()
  await Promise.allSettled(
    folders.flatMap((folder) =>
      folder.status === "fulfilled" ? [fs.rm(folder.value, { recursive: true, force: true })] : [],
    ),
  )
}

/**
 * Each block's folder outside the clone, by block id, for its saved plan and
 * what Terragrunt downloads. Created on first use, readable only by the user.
 */
const workFolders = new Map<string, Promise<string>>()
const workFolder = (blockId: string) => {
  let folder = workFolders.get(blockId)
  if (!folder) {
    folder = fs.mkdtemp(path.join(os.tmpdir(), "runbooks-terragrunt-apply-"))
    workFolders.set(blockId, folder)
  }
  return Effect.promise(() => folder)
}

/**
 * Each block's saved plan, by block id: the unit it's for, the unit's files
 * when it was made, and the credentials it was made with, so an apply never
 * applies a plan for other code or as someone else. A new plan replaces it,
 * and an apply uses it up.
 */
interface SavedPlan {
  readonly unit: string
  readonly planFile: string
  readonly fingerprint: string
  readonly identity: string
}

/** Who a run acts as: a hash of the env vars its auth blocks set, in any order. */
export function identityOf(env: Readonly<Record<string, string>>): string {
  const entries = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1))
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex")
}

const savedPlans = new Map<string, SavedPlan>()

const forgetPlan = (blockId: string) =>
  Effect.promise(async () => {
    const saved = savedPlans.get(blockId)
    savedPlans.delete(blockId)
    if (saved) await fs.rm(saved.planFile, { force: true })
  })

/** The clone's checkout and the unit's folder in it, which must hold a terragrunt.hcl. */
const unitOf = (request: TerragruntApplyRequest) =>
  Effect.gen(function* () {
    const worktree = yield* validateSessionPath(request.worktreePath)
    const relative = request.path.replace(/^\/+|\/+$/g, "")
    if (!relative || path.isAbsolute(request.path) || relative.split("/").includes("..")) {
      return yield* fail(
        `The path "${request.path}" isn't a folder in the clone. It's relative to the clone's root, such as aws/prod/global/budget.`,
      )
    }
    const unit = yield* validateSessionPath(path.join(worktree, relative))
    const hasConfig = yield* Effect.promise(() =>
      fs.stat(path.join(unit, "terragrunt.hcl")).then(
        (stat) => stat.isFile(),
        () => false,
      ),
    )
    if (!hasConfig) {
      return yield* fail(
        `There's no terragrunt.hcl in ${relative}. The block applies the Terragrunt unit in that folder of the clone.`,
      )
    }
    return { worktree, unit, relative }
  })

/** The session's env with the bound auth blocks' credentials on top, refusing any other name. */
const runEnv = (request: TerragruntApplyRequest) =>
  Effect.gen(function* () {
    const refused = disallowedEnvVars(request.env)
    if (refused.length > 0) {
      return yield* fail(`An auth block can't set ${refused.join(", ")} for a run.`)
    }
    const { env } = yield* sessionManager.getExecContext()
    return { ...env, ...request.env }
  })

/** Whether `name` is an executable file in a folder on `env`'s PATH. */
async function onPath(name: string, env: Record<string, string>): Promise<boolean> {
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

/** The first version number a command prints for `--version`, if it prints one. */
function versionOf(command: string, env: Record<string, string>): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--version"], { env, timeout: 10_000 }, (_err, stdout, stderr) => {
      resolve(/\d+\.\d+(\.\d+)?/.exec(`${stdout}\n${stderr}`)?.[0])
    })
  })
}

async function toolStatus(
  candidates: readonly string[],
  install: string,
  env: Record<string, string>,
): Promise<ToolStatus> {
  for (const command of candidates) {
    if (await onPath(command, env)) {
      const version = await versionOf(command, env)
      return { command, found: true, install, ...(version ? { version } : {}) }
    }
  }
  return { command: candidates[0]!, found: false, install }
}

/** Terragrunt, and the OpenTofu or Terraform it runs. */
const toolsFor = (env: Record<string, string>) =>
  Effect.promise(() =>
    Promise.all([
      toolStatus(["terragrunt"], TERRAGRUNT_INSTALL, env),
      toolStatus(["tofu", "terraform"], TOFU_INSTALL, env),
    ]),
  )

/** The path a `git status --porcelain` line names. */
const statusPath = (line: string) => line.slice(3).split(" -> ").pop() ?? ""

/**
 * Why the clone's changes aren't all on its remote, or nothing when they
 * are. The lock file a plan writes doesn't count: it's pushed with the next
 * change.
 */
export const unpushedChanges = (worktree: string) =>
  Effect.gen(function* () {
    const status = yield* gitLines(worktree, ["status", "--porcelain", "--untracked-files=all"])
    if (status === undefined) return "Couldn't read the clone's status with git."
    const changed = status.filter(
      (line) => line.trim() !== "" && path.basename(statusPath(line)) !== LOCK_FILE,
    )
    if (changed.length > 0) {
      return `The clone has ${changed.length === 1 ? "a change" : `${changed.length} changes`} that ${changed.length === 1 ? "isn't" : "aren't"} pushed, such as ${statusPath(changed[0]!)}. Push the changes with the pull request block, then plan: nothing is applied that isn't on the remote.`
    }
    const remote = yield* gitLines(worktree, ["branch", "-r", "--contains", "HEAD"])
    if (!remote?.some((line) => line.trim() !== "")) {
      return "The clone's commit isn't on any branch of its remote. Push it with the pull request block, then plan: nothing is applied that isn't on the remote."
    }
    return undefined
  })

/** Every file under `dir`, by path relative to `root`, leaving out what Terragrunt and OpenTofu write. */
async function unitFiles(root: string, dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!WORK_FOLDERS.has(entry.name)) files.push(...(await unitFiles(root, full)))
    } else if (entry.isFile()) {
      files.push(path.relative(root, full))
    }
  }
  return files
}

/**
 * What the unit's code is: a hash of its files, and the .hcl files in each
 * folder above it up to the clone's root, which it may include.
 */
export const fingerprintOf = (worktree: string, unit: string) =>
  Effect.promise(async () => {
    const files = await unitFiles(worktree, unit)
    for (let dir = path.dirname(unit); dir.startsWith(worktree); dir = path.dirname(dir)) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".hcl")) {
          files.push(path.relative(worktree, path.join(dir, entry.name)))
        }
      }
      if (dir === worktree) break
    }
    const hash = createHash("sha256")
    for (const file of files.sort()) {
      hash.update(`${file}\0`)
      hash.update(await fs.readFile(path.join(worktree, file)))
      hash.update("\0")
    }
    return hash.digest("hex")
  })

/**
 * The module the unit's source names, with its checks, or why its checks
 * can't run. A local source is relative to the unit and must stay in the
 * clone.
 */
const unitModule = (source: string, unit: string) =>
  Effect.gen(function* () {
    const dir = isRemoteSource(source)
      ? yield* moduleDir(source)
      : /^(\.\.?\/|\/)/.test(source)
        ? yield* validateSessionPath(path.resolve(unit, source.replace(/\/\//g, "/")))
        : undefined
    if (!dir) return { moduleNote: `Runbooks can't fetch ${source} to read its checks.` }
    return { module: yield* loadModule(dir) }
  }).pipe(
    Effect.catch((err) =>
      Effect.succeed({
        moduleNote: `Couldn't read the module's checks: ${describeFailure(err)}`,
      }),
    ),
  )

const terragrunt = (subcommand: readonly string[], run: ToolRun) => runTerragrunt(subcommand, run)

/**
 * Runs a block's plan or apply, streaming its events to the block, unless
 * the block is already running one. Settles once Terragrunt has exited, so
 * a stopped run reports Stopped only when nothing is left running.
 */
async function blockRun<T, E>(
  sender: WebContents,
  request: TerragruntRunRequest,
  kind: BlockRun["kind"],
  program: (
    send: (event: RunEvent) => void,
  ) => Effect.Effect<T, E, ManagedRuntime.ManagedRuntime.Services<typeof runtime>>,
): Promise<T> {
  const busy = blockRuns.get(request.blockId)
  if (busy) {
    throw fail(
      busy.kind === "apply"
        ? "The unit is being applied. Wait for the apply to finish, or stop it."
        : "The unit is being planned. Wait for the plan to finish, or stop it.",
    )
  }
  const controller = new AbortController()
  const send = (event: RunEvent) => {
    if (!sender.isDestroyed()) {
      sender.send("terragrunt-apply:event", {
        runId: request.runId,
        event,
        at: new Date().toISOString(),
      })
    }
  }
  const done = runtime.runPromise(program(send), { signal: controller.signal })
  blockRuns.set(request.blockId, { runId: request.runId, kind, controller, done })
  try {
    return await done
  } catch (err) {
    throw controller.signal.aborted ? fail("Stopped.") : err
  } finally {
    blockRuns.delete(request.blockId)
  }
}

const preflight = (request: TerragruntApplyRequest) =>
  Effect.gen(function* () {
    const env = yield* runEnv(request)
    const tools = yield* toolsFor(env)
    if (tools.some((tool) => !tool.found)) {
      return { kind: "missing-tools", tools } satisfies TerragruntPreflight
    }
    const { worktree, unit } = yield* unitOf(request)
    const unpushed = yield* unpushedChanges(worktree)
    if (unpushed)
      return { kind: "unpushed", tools, message: unpushed } satisfies TerragruntPreflight
    const downloadDir = path.join(yield* workFolder(request.blockId), "download")
    // Rendering evaluates the unit as a plan does, run_cmd and dependencies included.
    const rendered = renderedUnit(
      JSON.parse(
        yield* terragrunt(["render", "--format=json"], { cwd: unit, downloadDir, env }).pipe(
          Effect.timeoutOrElse({
            duration: "5 minutes",
            orElse: () =>
              Effect.fail(fail("Terragrunt took more than 5 minutes to render the unit.")),
          }),
        ),
      ),
    )
    const found = rendered.source ? yield* unitModule(rendered.source, unit) : {}
    return {
      kind: "ready",
      tools,
      ...(rendered.source ? { source: rendered.source } : {}),
      inputs: { ...rendered.inputs },
      ...found,
    } satisfies TerragruntPreflight
  })

export function registerTerragruntApplyHandlers(): void {
  ipcMain.handle("terragrunt-apply:preflight", (_event, params: TerragruntApplyRequest) =>
    simulationEnabled()
      ? runtime.runPromise(simulatedPreflight(params))
      : runtime.runPromise(preflight(params)),
  )

  ipcMain.handle("terragrunt-apply:plan", (event, params: TerragruntRunRequest) =>
    blockRun(event.sender, params, "plan", (send) =>
      Effect.gen(function* () {
        // Until this plan finishes, there's no plan to apply, real or simulated.
        yield* forgetPlan(params.blockId)
        if (simulationEnabled()) return yield* simulatePlan(params, { send })
        const env = yield* runEnv(params)
        const { worktree, unit } = yield* unitOf(params)
        const unpushed = yield* unpushedChanges(worktree)
        if (unpushed) return yield* fail(unpushed)
        const folder = yield* workFolder(params.blockId)
        const planFile = path.join(folder, `plan-${params.runId}.tfplan`)
        const where = { cwd: unit, downloadDir: path.join(folder, "download"), env }
        send({ kind: "step", step: "init" })
        let planning = false
        const onEvent = (e: RunEvent) => {
          if (!planning) {
            planning = true
            send({ kind: "step", step: "plan" })
          }
          send(e)
        }
        return yield* Effect.gen(function* () {
          yield* terragrunt(["plan", `-out=${planFile}`, "-json"], {
            ...where,
            onEvent,
            onLog: send,
          })
          const shown = yield* terragrunt(["show", "-json", planFile], where)
          // After the plan, so the lock file it writes is part of the unit it's for.
          const fingerprint = yield* fingerprintOf(worktree, unit)
          savedPlans.set(params.blockId, {
            unit,
            planFile,
            fingerprint,
            identity: identityOf(params.env),
          })
          const resources = plannedResources(JSON.parse(shown))
          if (resources.length > 0) return { resources } satisfies PlanResult
          const outputs = yield* terragrunt(["output", "-json"], where)
          return { resources, outputs: moduleOutputs(JSON.parse(outputs), []) } satisfies PlanResult
        }).pipe(
          // A plan that isn't saved for an apply mustn't stay on disk, since it can hold secrets.
          Effect.onExit((exit) =>
            exit._tag === "Success"
              ? Effect.void
              : Effect.promise(() => fs.rm(planFile, { force: true })),
          ),
        )
      }),
    ),
  )

  ipcMain.handle("terragrunt-apply:apply", (event, params: TerragruntRunRequest) =>
    blockRun(event.sender, params, "apply", (send) =>
      Effect.gen(function* () {
        if (simulationEnabled()) return yield* simulateApply(params, { send })
        const env = yield* runEnv(params)
        const { worktree, unit } = yield* unitOf(params)
        const saved = savedPlans.get(params.blockId)
        if (!saved || saved.unit !== unit) {
          return yield* fail("Plan first, so there's a plan to apply.")
        }
        if ((yield* fingerprintOf(worktree, unit)) !== saved.fingerprint) {
          yield* forgetPlan(params.blockId)
          return yield* fail("The unit's files changed since the plan. Plan again to apply them.")
        }
        if (identityOf(params.env) !== saved.identity) {
          yield* forgetPlan(params.blockId)
          return yield* fail(
            "The sign-in changed since the plan. Plan again, so the plan you review is made as who applies it.",
          )
        }
        const quiet = {
          cwd: unit,
          downloadDir: path.join(yield* workFolder(params.blockId), "download"),
          env,
        }
        send({ kind: "step", step: "apply" })
        // A plan is used up once it's applied, or once an apply of it fails or stops.
        yield* terragrunt(["apply", "-json", saved.planFile], {
          ...quiet,
          onEvent: send,
          onLog: send,
        }).pipe(Effect.ensuring(forgetPlan(params.blockId)))
        send({ kind: "step", step: "read" })
        const state = yield* terragrunt(["show", "-json"], quiet)
        const outputs = yield* terragrunt(["output", "-json"], quiet)
        return {
          resources: appliedResources(JSON.parse(state)),
          outputs: moduleOutputs(JSON.parse(outputs), []),
        } satisfies ApplyResult
      }),
    ),
  )

  ipcMain.handle("terragrunt-apply:cancel", (_event, params: { runId: string }) => {
    for (const run of blockRuns.values()) {
      if (run.runId === params.runId) run.controller.abort()
    }
    return { ok: true as const }
  })
}
