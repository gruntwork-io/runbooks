/**
 * Validate command: checks a module's runbook_block.yml and the recorded
 * answers in its simulation.yml, or the lookups a template's boilerplate.yml
 * declares, without the app, so a repository's own CI can catch a
 * declaration that drifted before a runbook does.
 */
import { existsSync, statSync } from "node:fs"
import * as path from "node:path"
import type { Command } from "commander"
import { Effect, Layer, ManagedRuntime } from "effect"
import { NodeFileSystemLive } from "../../src/layers/NodeFileSystem.ts"
import { FileSystem } from "../../src/services/FileSystem.ts"
import { readFormLookups } from "../../src/domain/boilerplate/lookups.ts"
import { SIMULATION_FILE } from "../../src/domain/simulation/file.ts"
import {
  checkSimulation,
  METADATA_FILE,
  readModuleDeclarations,
} from "../../src/domain/lookups/module.ts"
import type { Problem } from "../../src/domain/lookups/types.ts"

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description(
      "Check the lookups and checks a module or a template declares, and a module's recorded answers",
    )
    .argument(
      "<dirs...>",
      "OpenTofu module folders, or template folders with a boilerplate.yml or boilerplate.yaml",
    )
    .action(async (dirs: string[]) => {
      const runtime = ManagedRuntime.make(Layer.mergeAll(NodeFileSystemLive))
      let failed = false
      for (const dir of dirs) {
        const absolute = path.resolve(dir)
        const unusable = folderProblem(absolute)
        const problems = unusable
          ? [formatProblem(unusable)]
          : await runtime.runPromise(validateDir(absolute))
        if (problems.length === 0) {
          console.log(`ok  ${dir}`)
          continue
        }
        failed = true
        console.error(
          `${problems.length === 1 ? "1 problem" : `${problems.length} problems`} in ${dir}:`,
        )
        for (const problem of problems) console.error(`  ${problem}`)
      }
      await runtime.dispose()
      if (failed) process.exitCode = 1
    })
}

/** The names a template's declarations go by, in the order the app looks for them. */
const TEMPLATE_FILES = ["boilerplate.yml", "boilerplate.yaml"]

/** The template file in `dir`, if it's a template folder. */
export function templateFile(dir: string): string | undefined {
  return TEMPLATE_FILES.map((name) => path.join(dir, name)).find((file) => existsSync(file))
}

/**
 * Why `dir` can't be validated: it doesn't exist, isn't a folder, or has
 * nothing to check, so a mistyped path fails instead of passing.
 */
export function folderProblem(dir: string): Problem | undefined {
  const stat = statSync(dir, { throwIfNoEntry: false })
  if (!stat) return { source: dir, message: "doesn't exist." }
  if (!stat.isDirectory()) return { source: dir, message: "isn't a folder." }
  const declares =
    templateFile(dir) !== undefined ||
    [METADATA_FILE, SIMULATION_FILE].some((name) => existsSync(path.join(dir, name)))
  if (!declares) {
    const names = [METADATA_FILE, SIMULATION_FILE, ...TEMPLATE_FILES]
    return {
      source: dir,
      message: `has no ${names.slice(0, -1).join(", ")} or ${names.at(-1)}, so there's nothing to check.`,
    }
  }
  return undefined
}

/** Each problem in the folder, as a line to print: a template's when it has a template file, otherwise a module's. */
const validateDir = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const boilerplate = templateFile(dir)
    const text =
      boilerplate === undefined
        ? undefined
        : yield* fs.readFile(boilerplate).pipe(Effect.orElseSucceed(() => undefined))
    if (boilerplate !== undefined && text !== undefined) {
      const lookups = yield* readFormLookups(text, boilerplate, shownPath(boilerplate))
      return [...(lookups?.problems ?? [])]
    }
    const declarations = yield* readModuleDeclarations(dir)
    const simulation = yield* checkSimulation(dir, declarations)
    return [...declarations.problems, ...simulation].map(formatProblem)
  })

/** A path as the command shows it: relative to where it ran, when it's under there. */
function shownPath(file: string): string {
  const relative = path.relative(process.cwd(), file)
  return relative && !relative.startsWith("..") ? relative : file
}

export function formatProblem(problem: Problem): string {
  return `${shownPath(problem.source)}: ${problem.message}`
}
