/**
 * What the active scenario answers from simulation.yml, so a block skips the
 * sign-ins an answered step needs and runs, for real, what the scenario
 * leaves to it. The main process decides from the same answers (see
 * answers.ts); while there are none, every step reads as simulated, since
 * the main process refuses to run any for real then.
 */
import {
  simulatesLookup as answersLookup,
  simulatesScript as answersScript,
  simulatesUnit as answersUnit,
} from "../../../src/domain/simulation/answers"
import type { SimulationState } from "../../../electron/shared/channels"

/** Whether the scenario answers the <Command> or <Check> block `blockId`. */
export function simulatesScript(state: SimulationState, blockId: string): boolean {
  return state.enabled && state.answers !== undefined && answersScript(state.answers, blockId)
}

/** Whether the scenario answers the <TerragruntApply> block `blockId`. */
export function simulatesUnit(state: SimulationState, blockId: string): boolean {
  return state.enabled && (state.answers === undefined || answersUnit(state.answers, blockId))
}

/** Whether the scenario answers the lookup or check `id`, such as `google.domains`. */
export function simulatesLookup(state: SimulationState, id: string): boolean {
  return state.enabled && (state.answers === undefined || answersLookup(state.answers, id))
}

/** Whether nothing runs for real, so an auth block nobody signed in to reads as signed in. */
export function simulatesSignIn(state: SimulationState): boolean {
  return state.enabled && !state.answers?.runUnanswered
}
