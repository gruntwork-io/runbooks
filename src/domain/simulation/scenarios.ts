/**
 * Simulation mode: a runbook author previews blocks against canned answers
 * instead of real APIs and tools, so they can shape a runbook without signing
 * in or changing anything.
 *
 * The answers live in a simulation.yml beside the runbook, as named
 * scenarios. A scenario can extend another and replace some of its answers,
 * so "permission denied" is the happy path with one answer changed.
 *
 *   scenarios:
 *     happy-path:
 *       label: Happy path
 *       responses:
 *         google.domains:
 *           - status: 200
 *             body: { domains: [{ domainName: example.com }] }
 *     denied:
 *       extends: happy-path
 *       responses:
 *         google.domains:
 *           - { status: 403, body: The account can't read the directory. }
 *
 * `responses` answers lookups and checks by their id, in the shape a module's
 * own simulation.yml records them, so the engine reads a simulated answer
 * exactly as it reads a real one. `units` answers a <TerragruntApply> block's
 * preflight, plan and apply, by the block's id (see unit.ts), and `scripts`
 * answers a <Command> or <Check> block's run, by the block's id (see
 * script.ts).
 *
 * A <Command> or <Check> block a scenario doesn't name runs for real. A
 * lookup, check or <TerragruntApply> block it doesn't answer is an error, so
 * a forgotten answer never reaches a real API, unless the scenario sets
 * `runUnanswered: true`. Then everything it doesn't answer runs for real, and
 * a run can stand in for one step, such as creating an account, while every
 * other step really happens:
 *
 *   scenarios:
 *     real-run:
 *       runUnanswered: true
 *       units:
 *         apply-account:
 *           outputs: { account_id: "444455556666" }
 */
import YAML from "yaml"
import { SimulationError } from "../../errors/index.ts"
import { errorMessage } from "../../errors/message.ts"
import type { HttpReply } from "../../services/HttpRequest.ts"
import { isRecord, SIMULATION_FILE, simulationError } from "./file.ts"
import { readScript, type SimulatedScript } from "./script.ts"
import { readUnit, type SimulatedUnit } from "./unit.ts"

/** One canned answer to a lookup or check: for the use's params in `with`, or for any use without it. */
export interface SimulatedResponse {
  readonly with?: Readonly<Record<string, string>>
  readonly status: number
  readonly body: unknown
  /** How long it takes to answer, to show the loading state. */
  readonly delayMs?: number
}

export interface SimulationScenario {
  readonly name: string
  readonly label: string
  readonly description?: string
  /** Each lookup's and check's answers, by its id, with what the scenario extends merged in. */
  readonly responses: Readonly<Record<string, readonly SimulatedResponse[]>>
  /** Each <TerragruntApply> block's unit, by block id, with what the scenario extends merged in. */
  readonly units: Readonly<Record<string, SimulatedUnit>>
  /** Each <Command> and <Check> block's run, by block id, with what the scenario extends merged in. */
  readonly scripts: Readonly<Record<string, SimulatedScript>>
  /** Whether a lookup, check or unit the scenario doesn't answer runs for real instead of failing. */
  readonly runUnanswered: boolean
}

function readResponses(raw: unknown, where: string): SimulatedResponse[] {
  if (!Array.isArray(raw)) throw simulationError(`${where} must be a list of answers.`)
  return raw.map((answer, i) => {
    const at = `${where}[${i}]`
    if (!isRecord(answer) || typeof answer.status !== "number") {
      throw simulationError(`${at} needs a status and a body.`)
    }
    const params = answer.with
    if (
      params !== undefined &&
      (!isRecord(params) || !Object.values(params).every((v) => typeof v === "string"))
    ) {
      throw simulationError(`${at}.with must map each param to text.`)
    }
    return {
      ...(params ? { with: params as Record<string, string> } : {}),
      status: answer.status,
      body: answer.body ?? null,
      ...(typeof answer.delayMs === "number" ? { delayMs: answer.delayMs } : {}),
    }
  })
}

/** Reads simulation.yml into its scenarios, in file order. */
export function parseSimulation(content: string): SimulationScenario[] {
  let raw: unknown
  try {
    raw = YAML.parse(content)
  } catch (cause) {
    throw new SimulationError({
      message: `${SIMULATION_FILE} isn't valid YAML: ${errorMessage(cause)}`,
      cause,
    })
  }
  const scenarios = isRecord(raw) ? raw.scenarios : undefined
  if (!isRecord(scenarios) || Object.keys(scenarios).length === 0) {
    throw simulationError(`needs "scenarios", a map of at least one.`)
  }

  const resolved = new Map<string, SimulationScenario>()
  const resolve = (name: string, chain: readonly string[]): SimulationScenario => {
    const done = resolved.get(name)
    if (done) return done
    if (chain.includes(name)) {
      throw simulationError(
        `scenarios extend each other in a loop: ${[...chain, name].join(" → ")}.`,
      )
    }
    const entry = scenarios[name]
    if (!isRecord(entry)) throw simulationError(`there's no scenario "${name}".`)
    const base =
      typeof entry.extends === "string" ? resolve(entry.extends, [...chain, name]) : undefined
    const where = `scenarios.${name}`

    const responses: Record<string, readonly SimulatedResponse[]> = { ...base?.responses }
    const ownResponses = entry.responses ?? {}
    if (!isRecord(ownResponses)) {
      throw simulationError(`${where}.responses must map lookups and checks to answers.`)
    }
    for (const [id, answers] of Object.entries(ownResponses)) {
      responses[id] = readResponses(answers, `${where}.responses.${id}`)
    }

    const units: Record<string, SimulatedUnit> = { ...base?.units }
    const ownUnits = entry.units ?? {}
    if (!isRecord(ownUnits)) throw simulationError(`${where}.units must map blocks to units.`)
    for (const [block, answer] of Object.entries(ownUnits)) {
      // A unit keeps simulation.yml's keys, so the scenario can replace some of them.
      const inherited = base?.units[block]
      const merged = isRecord(answer) && inherited ? { ...inherited.raw, ...answer } : answer
      units[block] = readUnit(merged, `${where}.units.${block}`)
    }

    const scripts: Record<string, SimulatedScript> = { ...base?.scripts }
    const ownScripts = entry.scripts ?? {}
    if (!isRecord(ownScripts)) throw simulationError(`${where}.scripts must map blocks to runs.`)
    for (const [block, answer] of Object.entries(ownScripts)) {
      const inherited = base?.scripts[block]
      const merged = isRecord(answer) && inherited ? { ...inherited.raw, ...answer } : answer
      scripts[block] = readScript(merged, `${where}.scripts.${block}`)
    }

    const runUnanswered = entry.runUnanswered ?? base?.runUnanswered ?? false
    if (typeof runUnanswered !== "boolean") {
      throw simulationError(`${where}.runUnanswered must be true or false.`)
    }

    const scenario: SimulationScenario = {
      name,
      label: typeof entry.label === "string" ? entry.label : name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      responses,
      units,
      scripts,
      runUnanswered,
    }
    resolved.set(name, scenario)
    return scenario
  }
  return Object.keys(scenarios).map((name) => resolve(name, []))
}

/** Whether the scenario answers the <TerragruntApply> block `blockId`, rather than leaving it to run for real. */
export function simulatesUnit(scenario: SimulationScenario, blockId: string): boolean {
  return !scenario.runUnanswered || Object.hasOwn(scenario.units, blockId)
}

const sameParams = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([key, value]) => b[key] === value)

/**
 * The scenario's answer to the lookup or check `id` used with `params`: the
 * first whose `with` matches them, otherwise the first without one.
 */
export function simulatedResponse(
  scenario: SimulationScenario,
  id: string,
  params: Readonly<Record<string, string>>,
): { reply: HttpReply; delayMs: number } | undefined {
  const answers = scenario.responses[id] ?? []
  const answer =
    answers.find((a) => a.with && sameParams(a.with, params)) ?? answers.find((a) => !a.with)
  if (!answer) return undefined
  return {
    reply: {
      status: answer.status,
      contentType: "application/json",
      body: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
    },
    delayMs: answer.delayMs ?? 0,
  }
}

/** Says where to add an answer for `id`, which neither the runbook's scenario nor the module's recording has. */
export function noResponse(
  scenario: SimulationScenario,
  id: string,
  params: Readonly<Record<string, string>>,
): SimulationError {
  const using = Object.keys(params).length > 0 ? ` with ${JSON.stringify(params)}` : ""
  return simulationError(
    `scenario "${scenario.name}" has no answer for ${id}${using}, and the module records none. Add one under responses.${id}.`,
  )
}
