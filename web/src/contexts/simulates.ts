/**
 * What the active scenario answers from simulation.yml, so a block skips the
 * sign-ins an answered step needs and runs, for real, what the scenario
 * leaves to it.
 */
import { normalizeBlockId } from "@/lib/utils"
import type { SimulationState } from "../../../electron/shared/channels"

/** Whether the scenario runs the <Command> or <Check> block `blockId`. */
export function simulatesScript(state: SimulationState, blockId: string): boolean {
  return (
    state.enabled &&
    (state.scripts ?? []).some((id) => normalizeBlockId(id) === normalizeBlockId(blockId))
  )
}

/** Whether the scenario answers the <TerragruntApply> block `blockId`. */
export function simulatesUnit(state: SimulationState, blockId: string): boolean {
  return state.enabled && (!state.runUnanswered || (state.units ?? []).includes(blockId))
}

/** Whether the scenario answers the lookup or check `id`, such as `google.domains`. */
export function simulatesLookup(state: SimulationState, id: string): boolean {
  return state.enabled && (!state.runUnanswered || (state.responses ?? []).includes(id))
}
