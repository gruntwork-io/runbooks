/**
 * A <TerragruntApply> block's preflight, plan and apply in simulation mode:
 * answered from the active scenario's `units` by the block's id, streaming
 * the events a real run would, so the block looks as it would without
 * Terragrunt, a clone, or a sign-in.
 */
import { Effect } from "effect"
import { activeSimulationScenario } from "./simulation.ts"
import { moduleDir } from "./tf-module-source.ts"
import { describeFailure } from "./ipc-error.ts"
import { SimulationError } from "../../../src/errors/index.ts"
import type { FileSystem } from "../../../src/services/FileSystem.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import { SIMULATION_FILE } from "../../../src/domain/simulation/file.ts"
import {
  simulatedApplied,
  simulatedInputs,
  simulatedOutputs,
  simulatedPlan,
  simulatedResources,
  type SimulatedUnit,
} from "../../../src/domain/simulation/unit.ts"
import type {
  ApplyResult,
  PlanResult,
  ResourceAction,
  RunEvent,
} from "../../../src/domain/terragrunt/run.ts"
import type { TerragruntApplyRequest, TerragruntPreflight } from "../../shared/channels.ts"

const fail = (message: string) => new SimulationError({ message })

/** What a run streams to the block. Interrupting the run stops it. */
interface SimulatedRun {
  readonly send: (event: RunEvent) => void
}

/** The active scenario's unit for the block, and its inputs, or an error saying what to add. */
const unitFor = (request: TerragruntApplyRequest) =>
  Effect.gen(function* () {
    const scenario = yield* activeSimulationScenario
    const unit = scenario.units[request.blockId]
    if (!unit) {
      return yield* fail(
        `Simulation: scenario "${scenario.name}" in ${SIMULATION_FILE} has no answer for this block. Add one under units.${request.blockId}.`,
      )
    }
    return { unit, inputs: simulatedInputs(unit, request.blockInputs ?? {}) }
  })

/** The unit's module, read for its checks and outputs, as a <TfModule> block reads one. */
const moduleOf = (unit: SimulatedUnit) =>
  unit.source
    ? Effect.flatMap(moduleDir(unit.source), loadModule).pipe(
        Effect.map((module) => ({ module })),
        Effect.catch((err) =>
          Effect.succeed({
            moduleNote: `Couldn't read the module's checks: ${describeFailure(err)}`,
          }),
        ),
      )
    : Effect.succeed({})

export const simulatedPreflight = (request: TerragruntApplyRequest) =>
  Effect.gen(function* (): Effect.fn.Return<TerragruntPreflight, SimulationError, FileSystem> {
    const { unit, inputs } = yield* unitFor(request)
    const found = yield* moduleOf(unit)
    return {
      kind: "ready",
      tools: [],
      ...(unit.source ? { source: unit.source } : {}),
      inputs,
      ...found,
    } satisfies TerragruntPreflight
  })

const pause = (ms: number) => Effect.sleep(ms)

/** OpenTofu's counts of a plan's actions: a replace adds one and destroys one. */
function countActions(actions: readonly ResourceAction[]) {
  const count = (...of: ResourceAction[]) => actions.filter((a) => of.includes(a)).length
  return {
    add: count("create", "replace"),
    change: count("update"),
    destroy: count("delete", "replace"),
  }
}

/** What OpenTofu logs as it starts and finishes each action. */
const APPLY_WORDS: Record<ResourceAction, { start: string; done: string }> = {
  create: { start: "Creating...", done: "Creation complete" },
  update: { start: "Modifying...", done: "Modifications complete" },
  replace: { start: "Replacing...", done: "Creation complete" },
  delete: { start: "Destroying...", done: "Destruction complete" },
}

export const simulatePlan = (request: TerragruntApplyRequest, run: SimulatedRun) =>
  Effect.gen(function* () {
    const { unit, inputs } = yield* unitFor(request)
    run.send({ kind: "step", step: "init" })
    run.send({ kind: "log", line: "Simulated: nothing runs, and nothing real changes." })
    run.send({ kind: "log", line: "tofu: Initializing provider plugins..." })
    yield* pause(unit.delayMs)
    run.send({ kind: "step", step: "plan" })
    const plan = yield* Effect.try({
      try: () => simulatedPlan(unit, inputs),
      catch: (cause) => (cause instanceof SimulationError ? cause : fail(describeFailure(cause))),
    })
    for (const resource of plan.resources) {
      run.send({ kind: "log", line: `${resource.address}: Plan to ${resource.action}` })
    }
    yield* pause(unit.delayMs)
    const n = countActions(plan.resources.map((r) => r.action))
    run.send({
      kind: "log",
      line: `Plan: ${n.add} to add, ${n.change} to change, ${n.destroy} to destroy.`,
    })
    return plan satisfies PlanResult
  })

export const simulateApply = (request: TerragruntApplyRequest, run: SimulatedRun) =>
  Effect.gen(function* () {
    const { unit, inputs } = yield* unitFor(request)
    const found = yield* moduleOf(unit)
    const declared = "module" in found ? found.module.outputs : []
    run.send({ kind: "step", step: "apply" })
    const resources = simulatedResources(unit, inputs)
    for (const [index, { address, resource }] of resources.entries()) {
      const words = APPLY_WORDS[resource.action]
      run.send({ kind: "resource", address, progress: "working" })
      run.send({ kind: "log", line: `${address}: ${words.start}` })
      yield* pause(unit.delayMs)
      if (unit.applyError && index === resources.length - 1) {
        run.send({ kind: "resource", address, progress: "failed", message: unit.applyError })
        run.send({ kind: "log", line: unit.applyError, level: "error" })
        return yield* fail(unit.applyError)
      }
      run.send({ kind: "resource", address, progress: "done", elapsedSeconds: unit.delayMs / 1000 })
      run.send({ kind: "log", line: `${address}: ${words.done}` })
    }
    if (unit.applyError && resources.length === 0) return yield* fail(unit.applyError)
    const n = countActions(resources.map((r) => r.resource.action))
    run.send({
      kind: "log",
      line: `Apply complete! Resources: ${n.add} added, ${n.change} changed, ${n.destroy} destroyed.`,
    })
    return {
      resources: resources
        .filter(({ resource }) => resource.action !== "delete")
        .map(({ address, row, resource }) => simulatedApplied(address, row, resource)),
      outputs: simulatedOutputs(
        unit,
        inputs,
        declared.map((output) => output.name),
        new Set(declared.filter((output) => output.sensitive).map((output) => output.name)),
      ),
    } satisfies ApplyResult
  })
