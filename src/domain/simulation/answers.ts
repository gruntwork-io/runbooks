/**
 * What a simulation scenario answers, by key: what the main process and the
 * app's page both read to decide whether a block is simulated, so the two
 * can't decide differently.
 */
import { scriptKey } from "./script.ts"

export interface SimulationAnswers {
  /** Whether what the scenario doesn't answer runs for real, rather than failing or being refused. */
  readonly runUnanswered: boolean
  /** The <TerragruntApply> blocks it answers, by id. */
  readonly units: readonly string[]
  /** The <Command> and <Check> blocks it answers, by scriptKey of their ids. */
  readonly scripts: readonly string[]
  /** The lookups and checks it answers, such as `google.domains`. */
  readonly responses: readonly string[]
}

/**
 * Whether the <TerragruntApply> block `blockId` answers from the scenario.
 * Every unit does unless the scenario runs what it doesn't answer for real,
 * so a unit it forgot fails instead of running.
 */
export const simulatesUnit = (answers: SimulationAnswers, blockId: string) =>
  !answers.runUnanswered || answers.units.includes(blockId)

/** Whether the lookup or check `id` answers from the scenario, on the same terms as a unit. */
export const simulatesLookup = (answers: SimulationAnswers, id: string) =>
  !answers.runUnanswered || answers.responses.includes(id)

/**
 * Whether the <Command> or <Check> block `blockId` answers from the scenario.
 * One it doesn't answer is refused, or runs for real when the scenario runs
 * what it doesn't answer.
 */
export const simulatesScript = (answers: SimulationAnswers, blockId: string) =>
  answers.scripts.includes(scriptKey(blockId))
