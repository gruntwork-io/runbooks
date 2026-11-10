/**
 * Simulation mode: a runbook author previews blocks against canned answers
 * instead of real APIs, so they can shape a block's form without signing in
 * or changing anything.
 *
 * The answers live in a simulation.yml beside the runbook, as named
 * scenarios. A scenario can extend another and replace some of its answers,
 * so "permission denied" is the happy path with one lookup failing.
 *
 *   scenarios:
 *     happy-path:
 *       label: Happy path
 *       lookups:
 *         google.domains:
 *           - { domainName: example.com, isPrimary: true }
 *     denied:
 *       extends: happy-path
 *       lookups:
 *         google.people:
 *           error: The account can't read the directory.
 */
import YAML from "yaml"
import { TofuModuleError } from "../../errors/index.ts"
import { errorMessage } from "../../errors/message.ts"
import type { LookupRow } from "./rowTemplate.ts"

/** The name of the answers file beside a runbook. */
export const SIMULATION_FILE = "simulation.yml"

/** A lookup's canned answer: its rows, or the error it fails with. */
export type SimulatedLookup =
  | { readonly rows: readonly LookupRow[]; readonly delayMs?: number }
  | { readonly error: string; readonly delayMs?: number }

export interface SimulationScenario {
  readonly name: string
  readonly label: string
  readonly description?: string
  /** Every lookup's answer, with what the scenario extends already merged in. */
  readonly lookups: Readonly<Record<string, SimulatedLookup>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function readLookup(raw: unknown, where: string): SimulatedLookup {
  if (Array.isArray(raw)) {
    if (!raw.every(isRecord))
      throw new TofuModuleError({ message: `${where}: each row must be a map of fields.` })
    return { rows: raw }
  }
  if (isRecord(raw)) {
    const delayMs = typeof raw.delayMs === "number" ? { delayMs: raw.delayMs } : {}
    if (typeof raw.error === "string") return { error: raw.error, ...delayMs }
    if (Array.isArray(raw.rows) && raw.rows.every(isRecord)) return { rows: raw.rows, ...delayMs }
  }
  throw new TofuModuleError({
    message: `${where} must be a list of rows, or a map with "rows" or "error".`,
  })
}

/** Reads simulation.yml into its scenarios, in file order. */
export function parseSimulation(content: string): SimulationScenario[] {
  let raw: unknown
  try {
    raw = YAML.parse(content)
  } catch (cause) {
    throw new TofuModuleError({
      message: `${SIMULATION_FILE} isn't valid YAML: ${errorMessage(cause)}`,
      cause,
    })
  }
  const scenarios = isRecord(raw) ? raw.scenarios : undefined
  if (!isRecord(scenarios) || Object.keys(scenarios).length === 0) {
    throw new TofuModuleError({
      message: `${SIMULATION_FILE} needs "scenarios", a map of at least one.`,
    })
  }

  const resolved = new Map<string, SimulationScenario>()
  const resolve = (name: string, chain: readonly string[]): SimulationScenario => {
    const done = resolved.get(name)
    if (done) return done
    if (chain.includes(name)) {
      throw new TofuModuleError({
        message: `${SIMULATION_FILE}: scenarios extend each other in a loop: ${[...chain, name].join(" → ")}.`,
      })
    }
    const entry = scenarios[name]
    if (!isRecord(entry)) {
      throw new TofuModuleError({ message: `${SIMULATION_FILE}: there's no scenario "${name}".` })
    }
    const base =
      typeof entry.extends === "string" ? resolve(entry.extends, [...chain, name]).lookups : {}
    const own: Record<string, SimulatedLookup> = {}
    for (const [lookup, answer] of Object.entries(isRecord(entry.lookups) ? entry.lookups : {})) {
      own[lookup] = readLookup(answer, `${SIMULATION_FILE}: scenarios.${name}.lookups.${lookup}`)
    }
    const scenario: SimulationScenario = {
      name,
      label: typeof entry.label === "string" ? entry.label : name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      lookups: { ...base, ...own },
    }
    resolved.set(name, scenario)
    return scenario
  }
  return Object.keys(scenarios).map((name) => resolve(name, []))
}

/** Whether a row matches what the user typed: any of its text fields contains it. */
function matches(row: LookupRow, query: string): boolean {
  if (query === "") return true
  const needle = query.toLowerCase()
  return Object.values(row).some(
    (value) =>
      (typeof value === "string" || typeof value === "number") &&
      String(value).toLowerCase().includes(needle),
  )
}

/** A lookup's rows in a scenario, narrowed to what the user typed. Throws the scenario's error. */
export function simulatedRows(
  scenario: SimulationScenario,
  from: string,
  query: string,
): readonly LookupRow[] {
  const answer = scenario.lookups[from]
  if (!answer) {
    throw new TofuModuleError({
      message: `Simulation: scenario "${scenario.name}" in ${SIMULATION_FILE} has no answer for the lookup ${from}.`,
    })
  }
  if ("error" in answer) throw new TofuModuleError({ message: answer.error })
  return answer.rows.filter((row) => matches(row, query))
}
