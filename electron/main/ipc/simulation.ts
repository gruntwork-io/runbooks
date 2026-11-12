/**
 * Simulation mode for runbook authors: lookups, checks, <TerragruntApply>
 * blocks, and the <Command> and <Check> blocks a scenario names answer from
 * the simulation.yml beside the runbook instead of real APIs and tools.
 *
 * A lookup or check the runbook's scenario doesn't answer answers from the
 * `recorded` scenario of its module's own simulation.yml, which
 * `runbooks-cli lookups record` writes, so a module's recording serves
 * every runbook that uses it.
 *
 * Anything else that would reach a real system is refused (see
 * simulation-guard.ts). It's on for the whole app when it was launched with
 * `--simulate` (or RUNBOOKS_SIMULATE=1). The file is read on every request, so an edit shows
 * on the next lookup without reopening the runbook.
 */
import * as path from "path"
import { Effect, Result } from "effect"
import { ipcMain } from "electron"
import { runtime, runbookConfig } from "./runtime.ts"
import { moduleDir } from "./tf-module-source.ts"
import { FileSystem } from "../../../src/services/FileSystem.ts"
import { SimulationError } from "../../../src/errors/index.ts"
import { SIMULATION_FILE } from "../../../src/domain/simulation/file.ts"
import { RECORDED_SCENARIO } from "../../../src/domain/lookups/module.ts"
import {
  noResponse,
  parseSimulation,
  simulatedResponse,
  type SimulationScenario,
} from "../../../src/domain/simulation/scenarios.ts"
import type { SimulationRespondRequest, SimulationState } from "../../shared/channels.ts"
import { simulationRefusal, type SimulationCheck } from "./simulation-guard.ts"

let enabled = false
/** The scenario the author picked; the file's first one until they pick. */
let activeScenario: string | undefined

/** Turns simulation mode on for this run of the app. */
export function enableSimulation(): void {
  enabled = true
}

/** Turns simulation mode off and forgets the picked scenario, for a test that turned it on. */
export function disableSimulation(): void {
  enabled = false
  activeScenario = undefined
}

export function simulationEnabled(): boolean {
  return enabled
}

/**
 * Whether a call that would reach a real system may run: always outside
 * simulation mode, and never in it.
 */
export const simulationCheck: SimulationCheck = (channel) =>
  enabled ? simulationRefusal(channel) : undefined

const asSimulationError = (cause: unknown) =>
  cause instanceof SimulationError ? cause : new SimulationError({ message: String(cause), cause })

/** The scenarios in the simulation.yml in `dir`, or none when there's no such file. */
const scenariosIn = (dir: string) =>
  Effect.gen(function* () {
    const file = path.join(dir, SIMULATION_FILE)
    const fs = yield* FileSystem
    if (!(yield* fs.exists(file))) return undefined
    const content = yield* fs
      .readFile(file)
      .pipe(
        Effect.mapError(
          () => new SimulationError({ message: `Simulation: couldn't read ${file}.` }),
        ),
      )
    return yield* Effect.try({ try: () => parseSimulation(content), catch: asSimulationError })
  })

/** The scenarios in the open runbook's simulation.yml. */
const readScenarios = Effect.gen(function* () {
  const runbook = runbookConfig.localPath
  if (!runbook) {
    return yield* new SimulationError({ message: "Simulation: no runbook is open." })
  }
  const scenarios = yield* scenariosIn(path.dirname(runbook))
  if (!scenarios) {
    return yield* new SimulationError({
      message: `Simulation: add a ${SIMULATION_FILE} beside the runbook with the answers blocks should get.`,
    })
  }
  return scenarios
})

/** The answers `runbooks-cli lookups record` recorded in the module's simulation.yml, if any. */
const recordedFor = (source: string) =>
  Effect.gen(function* () {
    const dir = yield* moduleDir(source).pipe(Effect.mapError(asSimulationError))
    const scenarios = yield* scenariosIn(dir)
    return scenarios?.find((scenario) => scenario.name === RECORDED_SCENARIO)
  })

/** The scenario blocks answer from now. */
export const activeSimulationScenario: Effect.Effect<
  SimulationScenario,
  SimulationError,
  FileSystem
> = Effect.gen(function* () {
  const scenarios = yield* readScenarios
  return scenarios.find((scenario) => scenario.name === activeScenario) ?? scenarios[0]!
})

/**
 * The active scenario's run of the <Command> or <Check> block `blockId`, or
 * none when simulation is off or the scenario leaves the block to run for real.
 */
export const simulatedScript = (blockId: string) =>
  Effect.gen(function* () {
    if (!enabled) return undefined
    const scenario = yield* activeSimulationScenario
    const script = scenario.scripts[blockId]
    return script && { script, scenario: scenario.name }
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
      scripts: Object.keys(active.scripts),
    }
  })

  ipcMain.handle("simulation:set-scenario", (_event, params: { name: string }) => {
    if (!enabled) throw new Error("Simulation mode is off.")
    activeScenario = params.name
    return { ok: true as const }
  })

  ipcMain.handle("simulation:respond", (_event, params: SimulationRespondRequest) => {
    if (!enabled) throw new Error("Simulation mode is off.")
    return runtime.runPromise(
      Effect.gen(function* () {
        const scenario = yield* activeSimulationScenario
        const recorded = params.module ? yield* recordedFor(params.module) : undefined
        const answer =
          simulatedResponse(scenario, params.id, params.with) ??
          (recorded && simulatedResponse(recorded, params.id, params.with))
        if (!answer) return yield* noResponse(scenario, params.id, params.with)
        if (answer.delayMs > 0) yield* Effect.sleep(answer.delayMs)
        return answer.reply
      }),
    )
  })
}
