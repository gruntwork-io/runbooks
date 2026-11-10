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
 *
 * A scenario can also answer for a block's plan and apply, under `modules`
 * by the block's id: the resources the module makes and its outputs, as
 * templates over the block's inputs, such as `{{ .id }}`. A resource with
 * `forEach: owners` is one resource for each of the owners, whose templates
 * read it as `{{ .each }}`; `computed` holds what a plan shows as "known
 * after apply". A resource that exists already has `before`, its values now,
 * and the plan updates it; `action: delete` removes it.
 *
 * A scenario's `repository` stands in for the repository a <GitClone> block
 * would clone: its files by path, paths and contents both templates over the
 * block's inputs, so the Code tab can show the unit among them.
 */
import YAML from "yaml"
import { TfModuleError } from "../../errors/index.ts"
import { errorMessage } from "../../errors/message.ts"
import { renderRowTemplate, type LookupRow } from "./rowTemplate.ts"
import type {
  AppliedResource,
  ModuleOutputValue,
  PlanResult,
  PlannedResource,
  PropertyValue,
  ResourceAction,
} from "./run.ts"

/** The name of the answers file beside a runbook. */
export const SIMULATION_FILE = "simulation.yml"

/** A lookup's canned answer: its rows, or the error it fails with. */
export type SimulatedLookup =
  | { readonly rows: readonly LookupRow[]; readonly delayMs?: number }
  | { readonly error: string; readonly delayMs?: number }

/** A resource a simulated module makes, as templates over the block's inputs. */
export interface SimulatedResource {
  readonly address: string
  /** An input holding a list: the resource is one resource for each item, read as `.each`. */
  readonly forEach?: string
  readonly values: Readonly<Record<string, unknown>>
  /** Values a plan shows as known only after apply. */
  readonly computed: Readonly<Record<string, unknown>>
  /** The values of a resource that exists already. */
  readonly before?: Readonly<Record<string, unknown>>
  /** What the plan does to it: create, or update one with `before`, unless named. */
  readonly action: ResourceAction
}

/** A block's canned plan and apply. */
export interface SimulatedModule {
  readonly resources: readonly SimulatedResource[]
  readonly outputs: Readonly<Record<string, unknown>>
  /** How long each resource takes to apply. */
  readonly delayMs: number
  readonly planError?: string
  readonly applyError?: string
}

export interface SimulationScenario {
  readonly name: string
  readonly label: string
  readonly description?: string
  /** Every lookup's answer, with what the scenario extends already merged in. */
  readonly lookups: Readonly<Record<string, SimulatedLookup>>
  /** Every block's plan and apply, by block id, with what the scenario extends merged in. */
  readonly modules: Readonly<Record<string, SimulatedModule>>
  /** The simulated repository's files, by path, with what the scenario extends merged in. */
  readonly repository: Readonly<Record<string, string>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function readLookup(raw: unknown, where: string): SimulatedLookup {
  if (Array.isArray(raw)) {
    if (!raw.every(isRecord))
      throw new TfModuleError({ message: `${where}: each row must be a map of fields.` })
    return { rows: raw }
  }
  if (isRecord(raw)) {
    const delayMs = typeof raw.delayMs === "number" ? { delayMs: raw.delayMs } : {}
    if (typeof raw.error === "string") return { error: raw.error, ...delayMs }
    if (Array.isArray(raw.rows) && raw.rows.every(isRecord)) return { rows: raw.rows, ...delayMs }
  }
  throw new TfModuleError({
    message: `${where} must be a list of rows, or a map with "rows" or "error".`,
  })
}

function readRepository(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined) return {}
  const files = isRecord(raw) ? raw.files : undefined
  if (!isRecord(files) || !Object.values(files).every((content) => typeof content === "string")) {
    throw new TfModuleError({
      message: `${where} needs "files", a map from each file's path to its content.`,
    })
  }
  return files as Record<string, string>
}

/** The simulated repository's files for a block, with its inputs filled into paths and contents. */
export function simulatedRepository(
  scenario: SimulationScenario,
  inputs: LookupRow,
): Map<string, string> {
  return new Map(
    Object.entries(scenario.repository).map(([path, content]) => [
      renderRowTemplate(path, inputs),
      renderRowTemplate(content, inputs),
    ]),
  )
}

const ACTIONS: readonly ResourceAction[] = ["create", "update", "replace", "delete"]

function readModule(raw: unknown, where: string): SimulatedModule {
  if (!isRecord(raw)) throw new TfModuleError({ message: `${where} must be a map.` })
  const resources = (Array.isArray(raw.resources) ? raw.resources : []).map((entry, i) => {
    if (!isRecord(entry) || typeof entry.address !== "string") {
      throw new TfModuleError({ message: `${where}.resources[${i}] needs an "address".` })
    }
    const action = entry.action ?? (isRecord(entry.before) ? "update" : "create")
    if (!ACTIONS.includes(action as ResourceAction)) {
      throw new TfModuleError({
        message: `${where}.resources[${i}].action must be one of ${ACTIONS.join(", ")}.`,
      })
    }
    return {
      address: entry.address,
      ...(typeof entry.forEach === "string" ? { forEach: entry.forEach } : {}),
      values: isRecord(entry.values) ? entry.values : {},
      computed: isRecord(entry.computed) ? entry.computed : {},
      ...(isRecord(entry.before) ? { before: entry.before } : {}),
      action: action as ResourceAction,
    }
  })
  return {
    resources,
    outputs: isRecord(raw.outputs) ? raw.outputs : {},
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 600,
    ...(typeof raw.planError === "string" ? { planError: raw.planError } : {}),
    ...(typeof raw.applyError === "string" ? { applyError: raw.applyError } : {}),
  }
}

/** Reads simulation.yml into its scenarios, in file order. */
export function parseSimulation(content: string): SimulationScenario[] {
  let raw: unknown
  try {
    raw = YAML.parse(content)
  } catch (cause) {
    throw new TfModuleError({
      message: `${SIMULATION_FILE} isn't valid YAML: ${errorMessage(cause)}`,
      cause,
    })
  }
  const scenarios = isRecord(raw) ? raw.scenarios : undefined
  if (!isRecord(scenarios) || Object.keys(scenarios).length === 0) {
    throw new TfModuleError({
      message: `${SIMULATION_FILE} needs "scenarios", a map of at least one.`,
    })
  }

  const resolved = new Map<string, SimulationScenario>()
  const resolve = (name: string, chain: readonly string[]): SimulationScenario => {
    const done = resolved.get(name)
    if (done) return done
    if (chain.includes(name)) {
      throw new TfModuleError({
        message: `${SIMULATION_FILE}: scenarios extend each other in a loop: ${[...chain, name].join(" → ")}.`,
      })
    }
    const entry = scenarios[name]
    if (!isRecord(entry)) {
      throw new TfModuleError({ message: `${SIMULATION_FILE}: there's no scenario "${name}".` })
    }
    const base =
      typeof entry.extends === "string" ? resolve(entry.extends, [...chain, name]).lookups : {}
    const own: Record<string, SimulatedLookup> = {}
    for (const [lookup, answer] of Object.entries(isRecord(entry.lookups) ? entry.lookups : {})) {
      own[lookup] = readLookup(answer, `${SIMULATION_FILE}: scenarios.${name}.lookups.${lookup}`)
    }
    const baseModules =
      typeof entry.extends === "string" ? resolve(entry.extends, [...chain, name]).modules : {}
    const ownModules: Record<string, SimulatedModule> = {}
    for (const [block, answer] of Object.entries(isRecord(entry.modules) ? entry.modules : {})) {
      const inherited = baseModules[block]
      // A read module keeps simulation.yml's keys, so the scenario can replace some of them.
      const merged = isRecord(answer) && inherited ? { ...inherited, ...answer } : answer
      ownModules[block] = readModule(
        merged,
        `${SIMULATION_FILE}: scenarios.${name}.modules.${block}`,
      )
    }
    const baseRepository =
      typeof entry.extends === "string" ? resolve(entry.extends, [...chain, name]).repository : {}
    const ownRepository = readRepository(
      entry.repository,
      `${SIMULATION_FILE}: scenarios.${name}.repository`,
    )
    const scenario: SimulationScenario = {
      name,
      label: typeof entry.label === "string" ? entry.label : name,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      lookups: { ...base, ...own },
      modules: { ...baseModules, ...ownModules },
      repository: { ...baseRepository, ...ownRepository },
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
    throw new TfModuleError({
      message: `Simulation: scenario "${scenario.name}" in ${SIMULATION_FILE} has no answer for the lookup ${from}.`,
    })
  }
  if ("error" in answer) throw new TfModuleError({ message: answer.error })
  return answer.rows.filter((row) => matches(row, query))
}

/** One simulated resource for each item of its `forEach` input, or one. */
function expand(
  resource: SimulatedResource,
  inputs: LookupRow,
): { address: string; row: LookupRow; resource: SimulatedResource }[] {
  if (!resource.forEach) return [{ address: resource.address, row: inputs, resource }]
  const items = inputs[resource.forEach]
  return (Array.isArray(items) ? items : []).map((each) => {
    const row = { ...inputs, each }
    return { address: renderRowTemplate(resource.address, row), row, resource }
  })
}

/** A value with every string in it rendered as a template over `row`. */
function rendered(value: unknown, row: LookupRow): PropertyValue {
  if (typeof value === "string") return renderRowTemplate(value, row)
  if (Array.isArray(value)) return value.map((item) => rendered(item, row))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rendered(v, row)]))
  }
  return (value ?? null) as PropertyValue
}

/** A resource address's type and name: `type.name[key]`. */
function typeAndName(address: string): { type: string; name: string } {
  const [type = address, rest = ""] = address.split(".", 2)
  return { type, name: rest.replace(/\[.*$/, "") }
}

/** The simulated module's resources for these inputs, in the order they apply. */
export function simulatedResources(module: SimulatedModule, inputs: LookupRow) {
  return module.resources.flatMap((resource) => expand(resource, inputs))
}

export function simulatedPlan(module: SimulatedModule, inputs: LookupRow): PlanResult {
  if (module.planError) throw new TfModuleError({ message: module.planError })
  return {
    resources: simulatedResources(module, inputs).map(
      ({ address, row, resource }): PlannedResource => {
        const before = resource.before
          ? {
              before: {
                ...(rendered(resource.before, row) as Record<string, PropertyValue>),
                ...(rendered(resource.computed, row) as Record<string, PropertyValue>),
              },
            }
          : {}
        if (resource.action === "delete") {
          return { address, ...typeAndName(address), action: "delete", properties: {}, ...before }
        }
        // An existing resource keeps its computed values unless it's replaced.
        const computed =
          resource.before && resource.action === "update"
            ? (rendered(resource.computed, row) as Record<string, PropertyValue>)
            : Object.fromEntries(
                Object.keys(resource.computed).map((key) => [key, { hidden: "known after apply" }]),
              )
        return {
          address,
          ...typeAndName(address),
          action: resource.action,
          properties: {
            ...(rendered(resource.values, row) as Record<string, PropertyValue>),
            ...computed,
          },
          ...before,
        }
      },
    ),
  }
}

/** One applied resource: its values with the computed ones known. */
export function simulatedApplied(
  address: string,
  row: LookupRow,
  resource: SimulatedResource,
): AppliedResource {
  return {
    address,
    ...typeAndName(address),
    properties: {
      ...(rendered(resource.values, row) as Record<string, PropertyValue>),
      ...(rendered(resource.computed, row) as Record<string, PropertyValue>),
    },
  }
}

export function simulatedOutputs(
  module: SimulatedModule,
  inputs: LookupRow,
  sensitive: ReadonlySet<string>,
): ModuleOutputValue[] {
  return Object.entries(module.outputs).map(([name, value]) => {
    const out = rendered(value, inputs)
    return {
      name,
      value: typeof out === "string" ? out : JSON.stringify(out),
      sensitive: sensitive.has(name),
    }
  })
}
