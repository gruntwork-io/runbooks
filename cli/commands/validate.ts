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
    .argument("<dirs...>", "OpenTofu module folders, or template folders with a boilerplate.yml")
    .action(async (dirs: string[]) => {
      const runtime = ManagedRuntime.make(Layer.mergeAll(NodeFileSystemLive))
      let failed = false
      for (const dir of dirs) {
        const absolute = path.resolve(dir)
        const missing = missingFolder(absolute)
        const problems = missing
          ? [formatProblem(missing)]
          : await runtime.runPromise(validateDir(absolute))
        if (problems.length === 0) {
          const declares = [METADATA_FILE, "boilerplate.yml"].some((file) =>
            existsSync(path.join(absolute, file)),
          )
          console.log(declares ? `ok  ${dir}` : `ok  ${dir} (nothing to check)`)
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

/** Why `dir` can't be a module or template folder: it doesn't exist, or isn't a folder. */
export function missingFolder(dir: string): Problem | undefined {
  const stat = statSync(dir, { throwIfNoEntry: false })
  if (!stat) return { source: dir, message: "doesn't exist." }
  if (!stat.isDirectory()) return { source: dir, message: "isn't a folder." }
  return undefined
}

/** Each problem in the folder, as a line to print: a template's when it has a boilerplate.yml, otherwise a module's. */
const validateDir = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const boilerplate = path.join(dir, "boilerplate.yml")
    const text = yield* fs.readFile(boilerplate).pipe(Effect.orElseSucceed(() => undefined))
    if (text !== undefined) {
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
