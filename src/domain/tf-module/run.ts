/**
 * What a <TfModule> block shows while Terragrunt plans and applies the
 * module: the resources a plan would change, the resources an apply made, the
 * module's outputs, and progress as it goes.
 *
 * It reads OpenTofu's machine-readable output (`show -json`, `output -json`
 * and the `-json` UI stream), so the shapes here are OpenTofu's, narrowed to
 * what the block draws. Shared by the main process, which runs Terragrunt,
 * and the renderer.
 */

/** A value OpenTofu can't show: not known until apply, or marked sensitive. */
export interface HiddenValue {
  readonly hidden: "known after apply" | "sensitive"
}

/** A resource property: JSON, with some values hidden. */
export type PropertyValue =
  | string
  | number
  | boolean
  | null
  | HiddenValue
  | readonly PropertyValue[]
  | { readonly [key: string]: PropertyValue }

export function isHiddenValue(value: unknown): value is HiddenValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { hidden?: unknown }).hidden === "string"
  )
}

export type ResourceAction = "create" | "update" | "replace" | "delete"

export interface PlannedResource {
  readonly address: string
  readonly type: string
  readonly name: string
  readonly action: ResourceAction
  /** Its properties after the change; a deleted resource has none. */
  readonly properties: { readonly [key: string]: PropertyValue }
  /** Its properties before the change, for a resource that exists already. */
  readonly before?: { readonly [key: string]: PropertyValue }
}

export interface AppliedResource {
  readonly address: string
  readonly type: string
  readonly name: string
  readonly properties: { readonly [key: string]: PropertyValue }
}

export interface ModuleOutputValue {
  readonly name: string
  /** The value as text: a string as it is, anything else as JSON. */
  readonly value: string
  readonly sensitive: boolean
}

export interface PlanResult {
  readonly resources: readonly PlannedResource[]
}

export interface ApplyResult {
  readonly resources: readonly AppliedResource[]
  readonly outputs: readonly ModuleOutputValue[]
}

/** Where a resource is in an apply. */
export type ResourceProgress = "waiting" | "working" | "done" | "failed"

/** Something that happened while Terragrunt ran, as the block shows it. */
export type RunEvent =
  | { readonly kind: "step"; readonly step: "init" | "plan" | "apply" | "read" }
  /** A line for the log: Terragrunt's own, or OpenTofu's message. */
  | { readonly kind: "log"; readonly line: string; readonly level?: "error" | "warn" }
  | {
      readonly kind: "resource"
      readonly address: string
      readonly progress: ResourceProgress
      readonly elapsedSeconds?: number
      readonly message?: string
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A value with the parts OpenTofu marks unknown or sensitive hidden. The
 * marks mirror the value's shape: `true` where the whole value is marked, a
 * nested object or list where only some of it is.
 */
function withHidden(value: unknown, unknown: unknown, sensitive: unknown): PropertyValue {
  if (sensitive === true) return { hidden: "sensitive" }
  if (unknown === true) return { hidden: "known after apply" }
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      withHidden(
        item,
        Array.isArray(unknown) ? unknown[i] : undefined,
        Array.isArray(sensitive) ? sensitive[i] : undefined,
      ),
    )
  }
  if (isRecord(value)) {
    const out: Record<string, PropertyValue> = {}
    const keys = new Set([...Object.keys(value), ...Object.keys(isRecord(unknown) ? unknown : {})])
    for (const key of keys) {
      out[key] = withHidden(
        value[key],
        isRecord(unknown) ? unknown[key] : undefined,
        isRecord(sensitive) ? sensitive[key] : undefined,
      )
    }
    return out
  }
  if (value === undefined) return null
  return value as PropertyValue
}

function properties(value: unknown, unknown: unknown, sensitive: unknown) {
  const props = withHidden(value ?? {}, unknown, sensitive)
  return isRecord(props) ? (props as { [key: string]: PropertyValue }) : {}
}

/** What a change does to a managed resource; nothing for a no-op or a data source's read. */
function actionOf(actions: unknown): ResourceAction | undefined {
  const list = Array.isArray(actions) ? actions : []
  if (list.includes("create") && list.includes("delete")) return "replace"
  if (list.includes("create")) return "create"
  if (list.includes("update")) return "update"
  if (list.includes("delete")) return "delete"
  return undefined
}

/** The managed resources a plan (`show -json <plan>`) would change. */
export function plannedResources(plan: unknown): PlannedResource[] {
  const changes =
    isRecord(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : []
  const resources: PlannedResource[] = []
  for (const entry of changes) {
    if (!isRecord(entry) || entry.mode !== "managed" || !isRecord(entry.change)) continue
    const action = actionOf(entry.change.actions)
    if (!action) continue
    resources.push({
      address: String(entry.address),
      type: String(entry.type),
      name: String(entry.name),
      action,
      properties:
        action === "delete"
          ? {}
          : properties(
              entry.change.after,
              entry.change.after_unknown,
              entry.change.after_sensitive,
            ),
      ...(action === "create"
        ? {}
        : { before: properties(entry.change.before, undefined, entry.change.before_sensitive) }),
    })
  }
  return resources
}

/** The managed resources in a state (`show -json`), the root module's and its children's. */
export function appliedResources(state: unknown): AppliedResource[] {
  const resources: AppliedResource[] = []
  const visit = (module: unknown) => {
    if (!isRecord(module)) return
    for (const entry of Array.isArray(module.resources) ? module.resources : []) {
      if (!isRecord(entry) || entry.mode !== "managed") continue
      resources.push({
        address: String(entry.address),
        type: String(entry.type),
        name: String(entry.name),
        properties: properties(entry.values, undefined, entry.sensitive_values),
      })
    }
    for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) {
      visit(child)
    }
  }
  if (isRecord(state) && isRecord(state.values)) visit(state.values.root_module)
  return resources
}

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))

/** The module's outputs (`output -json`), in the order `order` names them, then the rest. */
export function moduleOutputs(outputs: unknown, order: readonly string[]): ModuleOutputValue[] {
  if (!isRecord(outputs)) return []
  const rank = (name: string) => {
    const i = order.indexOf(name)
    return i === -1 ? order.length : i
  }
  return Object.entries(outputs)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
    .map(([name, entry]) => ({
      name,
      value: asText(entry.value ?? null),
      sensitive: entry.sensitive === true,
    }))
    .sort((a, b) => rank(a.name) - rank(b.name))
}

/** The progress an OpenTofu `-json` UI message reports, if it's one the block shows. */
export function uiEvents(line: string): RunEvent[] {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return line.trim() ? [{ kind: "log", line }] : []
  }
  if (!isRecord(message)) return []
  const text = typeof message["@message"] === "string" ? message["@message"] : ""
  const level =
    message["@level"] === "error" ? "error" : message["@level"] === "warn" ? "warn" : undefined
  const log: RunEvent[] = text ? [{ kind: "log", line: text, ...(level ? { level } : {}) }] : []
  const hook = isRecord(message.hook) ? message.hook : undefined
  const resource = hook && isRecord(hook.resource) ? hook.resource : undefined
  const address = resource && typeof resource.addr === "string" ? resource.addr : undefined
  if (message.type === "diagnostic" && isRecord(message.diagnostic)) {
    const detail = message.diagnostic.detail
    return typeof detail === "string" && detail
      ? [...log, { kind: "log", line: detail, ...(level ? { level } : {}) }]
      : log
  }
  if (!address) return log
  const elapsed =
    hook && typeof hook.elapsed_seconds === "number" ? { elapsedSeconds: hook.elapsed_seconds } : {}
  switch (message.type) {
    case "apply_start":
      return [...log, { kind: "resource", address, progress: "working" }]
    case "apply_progress":
      return [{ kind: "resource", address, progress: "working", ...elapsed }]
    case "apply_complete":
      return [...log, { kind: "resource", address, progress: "done", ...elapsed }]
    case "apply_errored":
      return [...log, { kind: "resource", address, progress: "failed", ...elapsed, message: text }]
    default:
      return log
  }
}

/** A shell line that runs `command` in `cwd`, quoting what a shell would split. */
export function commandLine(cwd: string, command: string, args: readonly string[]): string {
  const quote = (word: string) =>
    /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`
  return `$ cd ${quote(cwd)} && ${[command, ...args].map(quote).join(" ")}`
}
