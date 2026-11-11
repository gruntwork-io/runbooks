/**
 * Validate command: checks a module's runbook_block.yml and the recorded
 * answers in its simulation.yml without the app, so a module's own CI can
 * catch a declaration that drifted before a runbook does.
 */
import * as path from "node:path"
import type { Command } from "commander"
import { Effect, Layer, ManagedRuntime } from "effect"
import { NodeFileSystemLive } from "../../src/layers/NodeFileSystem.ts"
import { checkSimulation, readModuleDeclarations } from "../../src/domain/lookups/module.ts"
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
        const problems = await runtime.runPromise(validateModule(path.resolve(dir)))
        if (problems.length === 0) {
          console.log(`ok  ${dir}`)
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
