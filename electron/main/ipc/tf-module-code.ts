/**
 * IPC handler for a <TfModule> block's code: the code the runbook's template
 * renders with the block's inputs to use the module, written to the
 * repository's checkout when the block generates it.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { moduleDir } from "./tf-module-source.ts"
import { BoilerplateRenderer } from "../../../src/services/BoilerplateRenderer.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import { describeFailure } from "./ipc-error.ts"
import { isRemoteSource } from "../../../src/remote-source.ts"
import { filesAtBase } from "../../../src/domain/tf-module/repoFiles.ts"
import {
  localModuleSource,
  remoteModuleSource,
} from "../../../src/domain/tf-module/pinnedSource.ts"
import { alignAttributes, isHclFile } from "../../../src/domain/tf-module/hclFormat.ts"
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
  TfModuleGenerated,
  TfModuleGenerateRequest,
  TfModuleRenderRequest,
  TfModuleRepo,
} from "../../shared/channels.ts"

export const fail = (message: string) => new TfModuleError({ message })

/**
 * The runbook's template rendered with the inputs and `ModuleSource`, where
 * the code finds the module; its files by path in the code's folder.
 */
export const renderTemplate = (
  template: string,
  values: Record<string, unknown>,
  moduleSource: string,
) =>
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
export const inWorkspaceTree = (blockId: string, files: readonly UnitFile[], tool: CodeTool) => {
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
 * writes it to the checkout. Without a checkout, there are none.
 */
const existingFiles = (repo: TfModuleRepo, folder: string, rendered: readonly UnitFile[]) =>
  Effect.gen(function* () {
    if (!repo.worktreePath) return new Map<string, string>()
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
 * pointing at a release of the module, among the files the repository
 * already holds around it.
 */
export const renderInRepo = (
  ref: TfModuleCodeRef,
  values: Record<string, unknown>,
  repo: TfModuleRepo,
) =>
  Effect.gen(function* () {
    const dir = yield* moduleDir(ref.source)
    // Code in a repository fetches the module itself, so it needs a release of it.
    const source = isRemoteSource(ref.source)
      ? yield* remoteModuleSource(ref.source, dir)
      : yield* localModuleSource(dir)
    const folder = yield* Effect.try({
      try: () => repoFolder(repo.path),
      catch: (cause) => fail(describeFailure(cause)),
    })
    const rendered = yield* renderTemplate(ref.template, values, source)
    const tool = toolFor(rendered)
    const placed = placeUnit(folder, rendered, yield* existingFiles(repo, folder, rendered))
    // The .hcl files above are context only for a Terragrunt unit, which may include them.
    const files = tool === "terragrunt" ? placed : placed.filter((f) => f.status !== "context")
    return {
      kind: "repo",
      tool,
      folder,
      files,
      rootHcl: hasRootHcl(files),
      source,
    } satisfies TfModuleCode
  })

/** The block's code, in the repository when it has one, otherwise in its workspace. */
export const renderCode = (request: TfModuleRenderRequest) =>
  request.repo
    ? renderInRepo(request, request.values, request.repo)
    : Effect.map(renderUnit(request, request.blockId, request.values), (code): TfModuleCode => ({
        kind: "workspace",
        ...code,
      }))

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex")

/**
 * Writes the block's unit to its folder in the repository's checkout: the
 * code the Code tab shows there, pointing at the module's pinned source.
 * Removes the files in `replaces`, ones written before for other inputs, that
 * it doesn't write now, unless they changed since, which it keeps. Returns
 * the code, the paths it wrote, relative to the checkout, with what it wrote
 * in each, and the files it kept.
 */
export const writeUnit = (
  ref: TfModuleCodeRef,
  values: Record<string, unknown>,
  repo: TfModuleRepo,
  worktree: string,
  replaces: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const code = yield* renderInRepo(ref, values, { ...repo, worktreePath: worktree })
    const files = unitFilesOf(code)
    yield* writeFiles(path.join(worktree, code.folder), files)
    const written = files.map((file) => `${code.folder}/${file.path}`)
    const fingerprints = Object.fromEntries(
      files.map((file) => [`${code.folder}/${file.path}`, sha256(file.content)]),
    )
    const stale = Object.entries(replaces).filter(([file]) => !written.includes(file))
    const kept = yield* Effect.tryPromise({
      try: () => removeStaleFiles(worktree, stale),
      catch: (cause) => fail(`Couldn't remove the old code: ${describeFailure(cause)}`),
    })
    return { code, written, fingerprints, kept }
  })

/**
 * Removes files under `root`, by their paths relative to it, and the folders
 * they leave empty. A file whose content no longer has the SHA-256 it was
 * written with was changed since, by hand or by another tool, so it's kept.
 * Returns the paths it kept.
 */
export async function removeStaleFiles(
  root: string,
  files: readonly (readonly [string, string])[],
): Promise<string[]> {
  const base = path.resolve(root)
  const kept: string[] = []
  for (const [file, fingerprint] of files) {
    const target = path.resolve(base, file)
    if (!target.startsWith(base + path.sep)) continue
    const content = await fs.readFile(target).catch(() => undefined)
    if (content === undefined) continue
    if (sha256(content) !== fingerprint) {
      kept.push(file)
      continue
    }
    await fs.rm(target, { force: true })
    let dir = path.dirname(target)
    while (dir !== base) {
      const left = await fs.readdir(dir).catch(() => ["unreadable"])
      if (left.length > 0) break
      await fs.rmdir(dir)
      dir = path.dirname(dir)
    }
  }
  return kept
}

/**
 * The block's code, written to its folder in the repository's checkout when
 * there is one. Without a checkout, nothing is written.
 */
const generateCode = (request: TfModuleGenerateRequest) =>
  Effect.gen(function* () {
    if (!request.repo?.worktreePath) {
      return {
        code: yield* renderCode(request),
        written: [],
        fingerprints: {},
        kept: [],
      } satisfies TfModuleGenerated
    }
    const worktree = yield* validateSessionPath(request.repo.worktreePath)
    return (yield* writeUnit(
      request,
      request.values,
      request.repo,
      worktree,
      request.replaces,
    )) satisfies TfModuleGenerated
  })

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

/** Writes files under `dir`, by their paths relative to it. */
export const writeFiles = (dir: string, files: readonly UnitFile[]) =>
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

export function registerTfModuleCodeHandlers(): void {
  ipcMain.handle("tf-module:render", async (_event, params: TfModuleRenderRequest) =>
    runtime.runPromise(renderCode(params)),
  )
  ipcMain.handle("tf-module:generate", async (_event, params: TfModuleGenerateRequest) =>
    runtime.runPromise(generateCode(params)),
  )
}
