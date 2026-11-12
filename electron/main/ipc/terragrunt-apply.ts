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
import { execFile, spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { Effect } from "effect"
import { ipcMain, type WebContents } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { moduleDir } from "./tf-module-source.ts"
import { describeFailure } from "./ipc-error.ts"
import { simulatedUnit } from "./simulation.ts"
import { simulateApply, simulatedPreflight, simulatePlan } from "./terragrunt-simulate.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import { isRemoteSource } from "../../../src/remote-source.ts"
import { disallowedEnvVars } from "../../../src/domain/exec/authEnv.ts"
import { gitLines } from "../../../src/domain/tf-module/git.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import { renderedUnit } from "../../../src/domain/terragrunt/render.ts"
import {
  appliedResources,
  commandLine,
  moduleOutputs,
  plannedResources,
  uiEvents,
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

const TERRAGRUNT_INSTALL = "https://terragrunt.gruntwork.io/docs/getting-started/install/"
const TOFU_INSTALL = "https://opentofu.org/docs/intro/install/"

/** The lock file a plan writes beside the unit, which is pushed with the next change. */
const LOCK_FILE = ".terraform.lock.hcl"

/** Folders in a unit that Terragrunt and OpenTofu write, which aren't the unit's code. */
const WORK_FOLDERS = new Set([".terragrunt-cache", ".terraform"])

/** Runs that can be cancelled, by run id. */
const activeRuns = new Map<string, AbortController>()

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
 * Each block's saved plan, by block id: the unit it's for, and the unit's
 * files when it was made, so an apply never applies a plan for other code. A
 * new plan replaces it, and an apply uses it up.
 */
interface SavedPlan {
  readonly unit: string
  readonly planFile: string
  readonly fingerprint: string
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

/** Starts a cancellable run that streams its events to the block. */
function startRun(sender: WebContents, runId: string) {
  activeRuns.get(runId)?.abort()
  const controller = new AbortController()
  activeRuns.set(runId, controller)
  const send = (event: RunEvent) => {
    if (!controller.signal.aborted && !sender.isDestroyed()) {
      sender.send("terragrunt-apply:event", { runId, event, at: new Date().toISOString() })
    }
  }
  const finish = () => {
    if (activeRuns.get(runId) === controller) activeRuns.delete(runId)
  }
  return { signal: controller.signal, send, finish }
}

/** Runs Terragrunt as an Effect, keeping a TfModuleError's message as it is. */
const terragrunt = (subcommand: readonly string[], run: ToolRun) =>
  Effect.tryPromise({
    try: () => runTerragrunt(subcommand, run),
    catch: (cause) => (cause instanceof TfModuleError ? cause : fail(describeFailure(cause))),
  })

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
        yield* terragrunt(["render", "--format=json"], {
          cwd: unit,
          downloadDir,
          env,
          signal: AbortSignal.timeout(5 * 60_000),
        }),
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
    runtime.runPromise(
      Effect.gen(function* () {
        if (yield* simulatedUnit(params.blockId)) return yield* simulatedPreflight(params)
        return yield* preflight(params)
      }),
    ),
  )

  ipcMain.handle("terragrunt-apply:plan", async (event, params: TerragruntRunRequest) => {
    const run = startRun(event.sender, params.runId)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          if (yield* simulatedUnit(params.blockId)) return yield* simulatePlan(params, run)
          // Until this plan finishes, there's no plan to apply.
          yield* forgetPlan(params.blockId)
          const env = yield* runEnv(params)
          const { worktree, unit } = yield* unitOf(params)
          const unpushed = yield* unpushedChanges(worktree)
          if (unpushed) return yield* fail(unpushed)
          const folder = yield* workFolder(params.blockId)
          const planFile = path.join(folder, `plan-${params.runId}.tfplan`)
          const where = { cwd: unit, downloadDir: path.join(folder, "download"), env }
          run.send({ kind: "step", step: "init" })
          let planning = false
          const onEvent = (e: RunEvent) => {
            if (!planning) {
              planning = true
              run.send({ kind: "step", step: "plan" })
            }
            run.send(e)
          }
          yield* terragrunt(["plan", `-out=${planFile}`, "-json"], {
            ...where,
            signal: run.signal,
            onEvent,
            onLog: run.send,
          })
          const shown = yield* terragrunt(["show", "-json", planFile], {
            ...where,
            signal: run.signal,
          })
          // After the plan, so the lock file it writes is part of the unit it's for.
          const fingerprint = yield* fingerprintOf(worktree, unit)
          savedPlans.set(params.blockId, { unit, planFile, fingerprint })
          return { resources: plannedResources(JSON.parse(shown)) } satisfies PlanResult
        }),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("terragrunt-apply:apply", async (event, params: TerragruntRunRequest) => {
    const run = startRun(event.sender, params.runId)
    try {
      return await runtime.runPromise(
        Effect.gen(function* () {
          if (yield* simulatedUnit(params.blockId)) return yield* simulateApply(params, run)
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
          const quiet = {
            cwd: unit,
            downloadDir: path.join(yield* workFolder(params.blockId), "download"),
            env,
            signal: run.signal,
          }
          run.send({ kind: "step", step: "apply" })
          // A plan is used up once it's applied, or once an apply of it fails.
          yield* terragrunt(["apply", "-json", saved.planFile], {
            ...quiet,
            onEvent: run.send,
            onLog: run.send,
          }).pipe(Effect.ensuring(forgetPlan(params.blockId)))
          run.send({ kind: "step", step: "read" })
          const state = yield* terragrunt(["show", "-json"], quiet)
          const outputs = yield* terragrunt(["output", "-json"], quiet)
          return {
            resources: appliedResources(JSON.parse(state)),
            outputs: moduleOutputs(JSON.parse(outputs), []),
          } satisfies ApplyResult
        }),
      )
    } finally {
      run.finish()
    }
  })

  ipcMain.handle("terragrunt-apply:cancel", (_event, params: { runId: string }) => {
    activeRuns.get(params.runId)?.abort()
    activeRuns.delete(params.runId)
    return { ok: true as const }
  })
}
