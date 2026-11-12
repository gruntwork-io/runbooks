/**
 * Validate command: checks a module's runbook_block.yml and the recorded
 * answers in its simulation.yml without the app, so a module's own CI can
 * catch a declaration that drifted before a runbook does.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { Command } from "commander"
import { Effect, Layer, ManagedRuntime } from "effect"
import { NodeFileSystemLive } from "../../src/layers/NodeFileSystem.ts"
import {
  checkSimulation,
  METADATA_FILE,
  readModuleDeclarations,
} from "../../src/domain/lookups/module.ts"
import type { Problem } from "../../src/domain/lookups/types.ts"

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Check the lookups and checks a module declares, and its recorded answers")
    .argument("<module-dirs...>", "OpenTofu module folders")
    .action(async (dirs: string[]) => {
      const runtime = ManagedRuntime.make(Layer.mergeAll(NodeFileSystemLive))
      let failed = false
      for (const dir of dirs) {
        const absolute = path.resolve(dir)
        const missing = missingModule(absolute)
        const problems = missing ? [missing] : await runtime.runPromise(validateModule(absolute))
        if (problems.length === 0) {
          const declares = fs.existsSync(path.join(absolute, METADATA_FILE))
          console.log(
            declares ? `ok  ${dir}` : `ok  ${dir} (no ${METADATA_FILE}, nothing to check)`,
          )
          continue
        }
        failed = true
        console.error(
          `${problems.length === 1 ? "1 problem" : `${problems.length} problems`} in ${dir}:`,
        )
        for (const problem of problems) console.error(`  ${formatProblem(problem)}`)
      }
      await runtime.dispose()
      if (failed) process.exitCode = 1
    })
}

/** Why `dir` can't be a module folder: it doesn't exist, or isn't a folder. */
export function missingModule(dir: string): Problem | undefined {
  const stat = fs.statSync(dir, { throwIfNoEntry: false })
  if (!stat) return { source: dir, message: "doesn't exist." }
  if (!stat.isDirectory()) return { source: dir, message: "isn't a folder." }
  return undefined
}

const validateModule = (moduleDir: string) =>
  Effect.gen(function* () {
    const declarations = yield* readModuleDeclarations(moduleDir)
    const simulation = yield* checkSimulation(moduleDir, declarations)
    return [...declarations.problems, ...simulation]
  })

export function formatProblem(problem: Problem): string {
  const relative = path.relative(process.cwd(), problem.source)
  const shown = relative && !relative.startsWith("..") ? relative : problem.source
  return `${shown}: ${problem.message}`
}
