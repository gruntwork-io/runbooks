/**
 * IPC handler for whether a <TfModule> block has what it needs outside its
 * own inputs: the Google APIs it calls turned on in the signed-in project,
 * and the commands its code runs with on PATH. The block checks before the
 * user plans, so a missing one shows up with its fix rather than as a
 * failed lookup or plan.
 */
import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"
import { activeCredentialFor } from "./google-credential-registry.ts"
import { validateSessionPath } from "./path-guard.ts"
import { GoogleClient } from "../../../src/services/GoogleClient.ts"
import { toolFor, type CodeTool } from "../../../src/domain/tf-module/unit.ts"
import type { TfModuleReadiness, TfModuleReadinessRequest } from "../../shared/channels.ts"

type Readiness = TfModuleReadiness

export const TERRAGRUNT_INSTALL = "https://terragrunt.gruntwork.io/docs/getting-started/install/"
const TOFU_INSTALL = "https://opentofu.org/docs/intro/install/"

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
): Promise<Readiness["tools"][number]> {
  for (const command of candidates) {
    if (await onPath(command, env)) {
      const version = await versionOf(command, env)
      return { command, found: true, install, ...(version ? { version } : {}) }
    }
  }
  return { command: candidates[0]!, found: false, install }
}

/** The commands code for `tool` runs with: Terragrunt runs OpenTofu or Terraform in turn. */
async function toolsFor(tool: CodeTool, env: Record<string, string>): Promise<Readiness["tools"]> {
  const tofu = await toolStatus(["tofu", "terraform"], TOFU_INSTALL, env)
  if (tool === "tofu") return [tofu]
  return [await toolStatus(["terragrunt"], TERRAGRUNT_INSTALL, env), tofu]
}

/** What runs the code the template renders, read from the template's own top-level files. */
const templateTool = (template: string) =>
  Effect.gen(function* () {
    const dir = yield* validateSessionPath(template).pipe(Effect.option)
    if (dir._tag === "None") return "tofu" satisfies CodeTool
    const names = yield* Effect.promise(() => fs.readdir(dir.value).catch((): string[] => []))
    return toolFor(names.map((name) => ({ path: name, content: "" })))
  })

const googleReadiness = (services: readonly string[]) =>
  Effect.gen(function* () {
    if (services.length === 0) return { kind: "none" } satisfies Readiness["google"]
    const credential = activeCredentialFor(undefined)
    if (!credential) return { kind: "signed-out" } satisfies Readiness["google"]
    const project = credential.projectId
    if (!project) return { kind: "no-project" } satisfies Readiness["google"]
    const google = yield* GoogleClient
    return yield* google.enabledServices(credential.ref, project, services, project).pipe(
      Effect.map((enabled): Readiness["google"] => ({ kind: "checked", project, enabled })),
      Effect.catch((error) =>
        Effect.succeed<Readiness["google"]>({ kind: "error", project, message: error.message }),
      ),
    )
  })

export function registerTfModuleReadyHandlers(): void {
  ipcMain.handle("tf-module:readiness", async (_event, params: TfModuleReadinessRequest) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const google = yield* googleReadiness(params?.services ?? [])
        const { env } = yield* sessionManager.getExecContext()
        const tool = yield* templateTool(params?.template ?? "")
        const tools = yield* Effect.promise(() => toolsFor(tool, env))
        return { google, tools } satisfies Readiness
      }),
    ),
  )
}
