/**
 * What a simulated <TerragruntApply> block's unit renders, plans and applies,
 * from a scenario's `units`, by the block's id:
 *
 *   units:
 *     apply-group:
 *       inputsFrom: group      # a block whose inputs stand for the unit's
 *       source: google-group   # the unit's module, for its checks and outputs
 *       resources:
 *         - address: google_cloud_identity_group.group
 *           values: { group_key: [{ id: "{{ .id }}" }] }
 *           computed: { name: groups/03x5example }
 *       outputs:
 *         email: "{{ .id }}"
 *
 * Resources and outputs are templates over the unit's inputs, such as
 * `{{ .id }}`. A resource with `forEach: owners` is one resource for each of
 * the owners, whose templates read it as `{{ .each }}`; `computed` holds what
 * a plan shows as "known after apply". A resource that exists already has
 * `before`, its values now, and the plan updates it; `action: delete`
 * removes it.
 */
import { renderRowTemplate, type LookupRow } from "../tf-module/rowTemplate.ts"
import type {
  AppliedResource,
  ModuleOutputValue,
  PlanResult,
  PlannedResource,
  PropertyValue,
  ResourceAction,
} from "../terragrunt/run.ts"
import { SimulationError } from "../../errors/index.ts"
import { isRecord, simulationError } from "./file.ts"

/** A resource a simulated unit makes, as templates over its inputs. */
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

export interface SimulatedUnit {
  /** A block whose inputs stand for the unit's, under `inputs`. */
  readonly inputsFrom?: string
  readonly inputs: Readonly<Record<string, unknown>>
  /** The unit's module, as a <TfModule> block names one, so its checks run and its outputs read as it declares. */
  readonly source?: string
  readonly resources: readonly SimulatedResource[]
  readonly outputs: Readonly<Record<string, unknown>>
  /** How long each step and each resource takes. */
  readonly delayMs: number
  readonly planError?: string
  readonly applyError?: string
  /** The keys as simulation.yml gives them, for a scenario that extends this one to replace some. */
  readonly raw: Readonly<Record<string, unknown>>
}

const ACTIONS: readonly ResourceAction[] = ["create", "update", "replace", "delete"]

export function readUnit(raw: unknown, where: string): SimulatedUnit {
  if (!isRecord(raw)) throw simulationError(`${where} must be a map.`)
  if (raw.inputs !== undefined && !isRecord(raw.inputs)) {
    throw simulationError(`${where}.inputs must map each input to its value.`)
  }
  const resources = (Array.isArray(raw.resources) ? raw.resources : []).map((entry, i) => {
    if (!isRecord(entry) || typeof entry.address !== "string") {
      throw simulationError(`${where}.resources[${i}] needs an "address".`)
    }
    const action = entry.action ?? (isRecord(entry.before) ? "update" : "create")
    if (!ACTIONS.includes(action as ResourceAction)) {
      throw simulationError(`${where}.resources[${i}].action must be one of ${ACTIONS.join(", ")}.`)
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
    ...(typeof raw.inputsFrom === "string" ? { inputsFrom: raw.inputsFrom } : {}),
    inputs: isRecord(raw.inputs) ? raw.inputs : {},
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
    resources,
    outputs: isRecord(raw.outputs) ? raw.outputs : {},
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 600,
    ...(typeof raw.planError === "string" ? { planError: raw.planError } : {}),
    ...(typeof raw.applyError === "string" ? { applyError: raw.applyError } : {}),
    raw,
  }
}

/** The unit's inputs: the inputs of the block it names, under the ones it gives. */
export function simulatedInputs(
  unit: SimulatedUnit,
  blockInputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Record<string, unknown> {
  return { ...(unit.inputsFrom ? blockInputs[unit.inputsFrom] : {}), ...unit.inputs }
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

const renderedMap = (value: Readonly<Record<string, unknown>>, row: LookupRow) =>
  rendered(value, row) as Record<string, PropertyValue>

/** A resource address's type and name: `type.name[key]`. */
function typeAndName(address: string): { type: string; name: string } {
  const [type = address, rest = ""] = address.split(".", 2)
  return { type, name: rest.replace(/\[.*$/, "") }
}

/** The simulated unit's resources for these inputs, in the order they apply. */
export function simulatedResources(unit: SimulatedUnit, inputs: LookupRow) {
  return unit.resources.flatMap((resource) => expand(resource, inputs))
}

export function simulatedPlan(unit: SimulatedUnit, inputs: LookupRow): PlanResult {
  if (unit.planError) throw new SimulationError({ message: unit.planError })
  return {
    resources: simulatedResources(unit, inputs).map(
      ({ address, row, resource }): PlannedResource => {
        const before = resource.before
          ? {
              before: {
                ...renderedMap(resource.before, row),
                ...renderedMap(resource.computed, row),
              },
            }
          : {}
        if (resource.action === "delete") {
          return { address, ...typeAndName(address), action: "delete", properties: {}, ...before }
        }
        // An existing resource keeps its computed values unless it's replaced.
        const computed =
          resource.before && resource.action === "update"
            ? renderedMap(resource.computed, row)
            : Object.fromEntries(
                Object.keys(resource.computed).map((key) => [key, { hidden: "known after apply" }]),
              )
        return {
          address,
          ...typeAndName(address),
          action: resource.action,
          properties: { ...renderedMap(resource.values, row), ...computed },
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
    properties: { ...renderedMap(resource.values, row), ...renderedMap(resource.computed, row) },
  }
}

/** The unit's outputs, in the order `order` gives and then the file's, marked sensitive as `sensitive` says. */
export function simulatedOutputs(
  unit: SimulatedUnit,
  inputs: LookupRow,
  order: readonly string[],
  sensitive: ReadonlySet<string>,
): ModuleOutputValue[] {
  const rank = (name: string) => {
    const at = order.indexOf(name)
    return at === -1 ? order.length : at
  }
  return Object.entries(unit.outputs)
    .map(([name, value]) => {
      const out = rendered(value, inputs)
      return {
        name,
        value: typeof out === "string" ? out : JSON.stringify(out),
        sensitive: sensitive.has(name),
      }
    })
    .sort((a, b) => rank(a.name) - rank(b.name))
}
