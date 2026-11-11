/**
 * Simulation mode for runbook authors: blocks answer from the simulation.yml
 * beside the runbook instead of calling real APIs.
 *
 * It's on for the whole app when it was launched with `--simulate` (or
 * RUNBOOKS_SIMULATE=1). The file is read on every request, so editing it
 * shows on the next lookup without reopening the runbook.
 */
import * as path from "path"
import { Effect, Result } from "effect"
import { ipcMain } from "electron"
import { runtime, runbookConfig } from "./runtime.ts"
import { FileSystem } from "../../../src/services/FileSystem.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import {
  SIMULATION_FILE,
  parseSimulation,
  type SimulationScenario,
} from "../../../src/domain/tf-module/simulation.ts"
import type { SimulationState } from "../../shared/channels.ts"

let enabled = false
/** The scenario the author picked; the file's first one until they pick. */
let activeScenario: string | undefined

/** Turns simulation mode on for this run of the app. */
export function enableSimulation(): void {
  enabled = true
}

export function simulationEnabled(): boolean {
  return enabled
}

/** The scenarios in the open runbook's simulation.yml. */
const readScenarios = Effect.gen(function* () {
  const runbook = runbookConfig.localPath
  if (!runbook) {
    return yield* new TfModuleError({ message: "Simulation: no runbook is open." })
  }
  const file = path.join(path.dirname(runbook), SIMULATION_FILE)
  const fs = yield* FileSystem
  if (!(yield* fs.exists(file))) {
    return yield* new TfModuleError({
      message: `Simulation: add a ${SIMULATION_FILE} beside the runbook with the answers blocks should get.`,
    })
  }
  const content = yield* fs
    .readFile(file)
    .pipe(
      Effect.mapError(
        () => new TfModuleError({ message: `Simulation: couldn't read ${SIMULATION_FILE}.` }),
      ),
    )
  return yield* Effect.try({
    try: () => parseSimulation(content),
    catch: (cause) =>
      cause instanceof TfModuleError ? cause : new TfModuleError({ message: String(cause), cause }),
  })
})

/** The scenario lookups answer from now. */
export const activeSimulationScenario: Effect.Effect<
  SimulationScenario,
  TfModuleError,
  FileSystem
> = Effect.gen(function* () {
  const scenarios = yield* readScenarios
  return scenarios.find((scenario) => scenario.name === activeScenario) ?? scenarios[0]!
})

export function registerSimulationHandlers(): void {
  ipcMain.handle("simulation:state", async (): Promise<SimulationState> => {
    if (!enabled) return { enabled: false }
    const result = await runtime.runPromise(Effect.result(readScenarios))
    if (Result.isFailure(result))
      return { enabled: true, scenarios: [], error: result.failure.message }
    const scenarios = result.success
    const active = scenarios.find((scenario) => scenario.name === activeScenario) ?? scenarios[0]!
    return {
      enabled: true,
      scenarios: scenarios.map(({ name, label, description }) => ({
        name,
        label,
        ...(description ? { description } : {}),
      })),
      active: active.name,
    }
  })

  ipcMain.handle("simulation:set-scenario", (_event, params: { name: string }) => {
    if (!enabled) throw new Error("Simulation mode is off.")
    activeScenario = params.name
    return { ok: true as const }
  })
}
