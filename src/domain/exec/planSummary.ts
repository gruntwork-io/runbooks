/**
 * Plan summaries: what a script's OpenTofu/Terraform plans will change, read
 * from the JSON a plan's `show -json` prints, for the block's View Plan panel.
 *
 * Every run gets a directory named by RUNBOOK_PLAN_DIR. A script writes plans
 * there as JSON: Terragrunt does it for every unit of a `run --all plan` given
 * `--json-out-dir "$RUNBOOK_PLAN_DIR"`, and a single plan can be written with
 * `tofu show -json`. A Terragrunt run report written there in JSON
 * (`--report-file "$RUNBOOK_PLAN_DIR/report.json"`) adds each unit's result,
 * so a unit that failed before it planned still shows.
 *
 * Shared by the main process and the renderer, so it must stay free of Node
 * and Electron imports. Sensitive values never leave it: a value the plan
 * marks sensitive is summarized as `sensitive: true` with no value, so the
 * summary can cross IPC and be saved with the session.
 */

/** The environment variable that names the run's plan directory. */
export const PLAN_DIR_ENV_VAR = "RUNBOOK_PLAN_DIR"

/** What a plan does to one resource. */
export type PlanAction =
  | "create"
  | "update"
  | "delete"
  | "replace"
  | "import"
  | "forget"
  | "move"
  | "read"

/** One attribute of a resource change. Values are JSON, cut to MAX_VALUE_CHARS. */
export interface PlanAttributeChange {
  /** e.g. `tags.Name`, `ingress[0].cidr_blocks[1]` */
  readonly path: string
  /** The value before, absent for a create, or when it was null */
  readonly before?: string
  /** The value after, absent for a delete, when it was null, or when it's unknown */
  readonly after?: string
  /** Whether the value is only known after apply */
  readonly unknownAfter?: boolean
  /** Whether the plan marks the value sensitive. Its values are left out. */
  readonly sensitive?: boolean
  /** Whether a change to this attribute is why the resource is replaced */
  readonly forcesReplacement?: boolean
}

export interface PlanResourceChange {
  readonly address: string
  readonly action: PlanAction
  /** Where a moved resource was before */
  readonly previousAddress?: string
  /** Whether the resource is also imported */
  readonly importing?: boolean
  /** The attributes that change. A delete lists none. */
  readonly attributes: readonly PlanAttributeChange[]
  /** How many changed attributes were left out past MAX_ATTRIBUTES */
  readonly omittedAttributes?: number
}

export interface PlanCounts {
  readonly add: number
  readonly change: number
  readonly destroy: number
  readonly replace: number
  readonly import: number
  readonly forget: number
  readonly move: number
}

/** A Terragrunt run report's result for a unit. */
export type UnitResult = "succeeded" | "failed" | "early exit" | "excluded"

export interface PlanUnit {
  /** The unit's path relative to the plan directory, or the plan file's name */
  readonly name: string
  /** Whether a plan was found for the unit */
  readonly planned: boolean
  /** Whether the plan says planning errored partway */
  readonly errored?: boolean
  /** Why the unit's plan file couldn't be read */
  readonly error?: string
  readonly counts: PlanCounts
  /** The resources that change, most destructive first */
  readonly resources: readonly PlanResourceChange[]
  /** How many changed resources were left out past MAX_RESOURCES */
  readonly omittedResources?: number
  /** The outputs that change */
  readonly outputs: readonly { readonly name: string; readonly action: PlanAction }[]
  /** From the run report, when there is one */
  readonly result?: UnitResult
  readonly reason?: string
  readonly cause?: string
}

export interface PlanSummary {
  readonly units: readonly PlanUnit[]
  /** Every unit's counts added up */
  readonly totals: PlanCounts
}

/** The largest plan file read. A bigger one is reported, not parsed. */
export const MAX_PLAN_FILE_BYTES = 64 * 1024 * 1024
const MAX_RESOURCES = 500
const MAX_ATTRIBUTES = 100
const MAX_VALUE_CHARS = 300

export const emptyCounts = (): PlanCounts => ({
  add: 0,
  change: 0,
  destroy: 0,
  replace: 0,
  import: 0,
  forget: 0,
  move: 0,
})

/** Whether `counts` has any change in it. */
export function hasChanges(counts: PlanCounts): boolean {
  return Object.values(counts).some((n) => n > 0)
}

const addCounts = (a: PlanCounts, b: PlanCounts): PlanCounts => ({
  add: a.add + b.add,
  change: a.change + b.change,
  destroy: a.destroy + b.destroy,
  replace: a.replace + b.replace,
  import: a.import + b.import,
  forget: a.forget + b.forget,
  move: a.move + b.move,
})

// ---------------------------------------------------------------------------
// Reading a plan
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Whether `value` is the JSON a plan's `show -json` prints. */
export function isPlanJson(value: unknown): value is Record<string, unknown> {
  return (
    isObject(value) &&
    typeof value["format_version"] === "string" &&
    ("resource_changes" in value || "planned_values" in value)
  )
}

/**
 * The action a change's `actions` list stands for, or null for a no-op.
 * OpenTofu lists a replace as delete and create, in either order.
 */
function actionOf(actions: unknown): PlanAction | null {
  if (!Array.isArray(actions)) return null
  const set = new Set(actions)
  if (set.has("delete") && set.has("create")) return "replace"
  if (set.has("create")) return "create"
  if (set.has("delete")) return "delete"
  if (set.has("update")) return "update"
  if (set.has("forget")) return "forget"
  if (set.has("read")) return "read"
  return null
}

/** Most destructive first, so a delete is never below the fold. */
const ACTION_ORDER: Record<PlanAction, number> = {
  delete: 0,
  replace: 1,
  forget: 2,
  update: 3,
  create: 4,
  import: 5,
  move: 6,
  read: 7,
}

/**
 * Whether the mask (`before_sensitive`, `after_unknown`, ...) marks `path`:
 * the mask mirrors the value, with `true` where it applies, at a leaf or over
 * a whole subtree.
 */
function marked(mask: unknown, path: readonly (string | number)[]): boolean {
  let node = mask
  for (const key of path) {
    if (node === true) return true
    if (Array.isArray(node) && typeof key === "number") node = node[key]
    else if (isObject(node) && typeof key === "string") node = node[key]
    else return false
  }
  return node === true
}

/** Whether a mask marks anything in it. */
function marksAny(mask: unknown): boolean {
  if (mask === true) return true
  if (Array.isArray(mask)) return mask.some(marksAny)
  if (isObject(mask)) return Object.values(mask).some(marksAny)
  return false
}

/**
 * Whether the value at `path` is, or has in it, something the mask marks.
 * A value shown whole (one only known after apply on the other side, say) is
 * hidden whole when any part of it is sensitive.
 */
const marksAnyAt = (mask: unknown, path: readonly (string | number)[]): boolean =>
  marked(mask, path) || marksAny(maskAt(mask, path))

/** The part of a mask at `path`, or undefined when it has none there. */
function maskAt(mask: unknown, path: readonly (string | number)[]): unknown {
  let node = mask
  for (const key of path) {
    if (Array.isArray(node) && typeof key === "number") node = node[key]
    else if (isObject(node) && typeof key === "string") node = node[key]
    else return undefined
  }
  return node
}

const formatPath = (path: readonly (string | number)[]): string =>
  path.map((key, i) => (typeof key === "number" ? `[${key}]` : i === 0 ? key : `.${key}`)).join("")

const formatValue = (value: Json): string => {
  const text = JSON.stringify(value)
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
}

/**
 * The leaves of `before` and `after` that differ, by path. An object or array
 * on one side only, or an empty one, is a leaf. A sensitive subtree is one
 * leaf, so nothing in it is compared or kept.
 */
function diffLeaves(
  before: Json | undefined,
  after: Json | undefined,
  masks: {
    beforeSensitive: unknown
    afterSensitive: unknown
    afterUnknown: unknown
    secrets: readonly string[]
  },
  path: (string | number)[],
  out: PlanAttributeChange[],
  replacePaths: readonly (readonly (string | number)[])[],
): void {
  const sensitive = marked(masks.beforeSensitive, path) || marked(masks.afterSensitive, path)
  const unknownAfter = marked(masks.afterUnknown, path)
  const forcesReplacement = replacePaths.some(
    (p) => p.length > 0 && p.length <= path.length && p.every((key, i) => key === path[i]),
  )

  const bothContainers =
    !sensitive &&
    !unknownAfter &&
    before !== undefined &&
    after !== undefined &&
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after)
  // A container on one side only is compared by its leaves too, against nothing.
  const oneSidedContainer =
    !sensitive &&
    !unknownAfter &&
    ((isNonEmptyContainer(before) && (after === undefined || after === null)) ||
      ((isNonEmptyContainer(after) ||
        isNonEmptyContainer(maskAt(masks.afterUnknown, path) as Json | undefined)) &&
        (before === undefined || before === null)))

  if (bothContainers || oneSidedContainer) {
    const keys = new Set<string | number>()
    // A value only known after apply is missing from `after`; its key is
    // only in the after_unknown mask.
    for (const side of [before, after, maskAt(masks.afterUnknown, path) as Json | undefined]) {
      if (Array.isArray(side)) side.forEach((_, i) => keys.add(i))
      else if (isObject(side)) Object.keys(side).forEach((k) => keys.add(k))
    }
    for (const key of keys) {
      const child = (side: Json | undefined): Json | undefined =>
        side === null || side === undefined
          ? undefined
          : Array.isArray(side)
            ? typeof key === "number"
              ? side[key]
              : undefined
            : typeof key === "string"
              ? (side as Record<string, Json>)[key]
              : undefined
      diffLeaves(child(before), child(after), masks, [...path, key], out, replacePaths)
    }
    return
  }

  // This value is shown whole. If any part of it is sensitive, all of it is
  // hidden.
  if (
    !sensitive &&
    ((isContainer(before) && marksAnyAt(masks.beforeSensitive, path)) ||
      (isContainer(after) && marksAnyAt(masks.afterSensitive, path)))
  ) {
    out.push({
      path: formatPath(path),
      sensitive: true,
      ...(unknownAfter ? { unknownAfter: true } : {}),
      ...(forcesReplacement ? { forcesReplacement: true } : {}),
    })
    return
  }

  const beforeText = before === undefined || before === null ? undefined : formatValue(before)
  const afterText =
    unknownAfter || after === undefined || after === null ? undefined : formatValue(after)
  if (!unknownAfter && beforeText === afterText) return
  if (sensitive && !unknownAfter && JSON.stringify(before) === JSON.stringify(after)) return
  // A value the plan doesn't mark can still hold a sensitive one: OpenTofu
  // loses the mark when a resource copies it into another attribute.
  const holdsSecret = [beforeText, afterText].some(
    (text) => text !== undefined && masks.secrets.some((secret) => text.includes(secret)),
  )

  const hidden = sensitive || holdsSecret
  out.push({
    path: formatPath(path),
    ...(hidden ? { sensitive: true } : {}),
    ...(!hidden && beforeText !== undefined ? { before: beforeText } : {}),
    ...(!hidden && afterText !== undefined ? { after: afterText } : {}),
    ...(unknownAfter ? { unknownAfter: true } : {}),
    ...(forcesReplacement ? { forcesReplacement: true } : {}),
  })
}

const isContainer = (value: Json | undefined): boolean =>
  value !== null && value !== undefined && typeof value === "object"

const isNonEmptyContainer = (value: Json | undefined): boolean =>
  (Array.isArray(value) && value.length > 0) || (isObject(value) && Object.keys(value).length > 0)

/** Shorter values aren't looked for in others: they'd match by chance. */
const MIN_SECRET_CHARS = 4

/** The scalar values in `value` that `mask` marks, as formatValue would print them, unquoted. */
function collectMarked(value: unknown, mask: unknown, out: Set<string>): void {
  if (mask === true) {
    const walk = (v: unknown): void => {
      if (typeof v === "string" || typeof v === "number") {
        const text = JSON.stringify(String(v)).slice(1, -1)
        if (text.length >= MIN_SECRET_CHARS) out.add(text)
      } else if (Array.isArray(v)) v.forEach(walk)
      else if (isObject(v)) Object.values(v).forEach(walk)
    }
    walk(value)
  } else if (Array.isArray(mask) && Array.isArray(value)) {
    mask.forEach((m, i) => collectMarked(value[i], m, out))
  } else if (isObject(mask) && isObject(value)) {
    for (const [key, m] of Object.entries(mask)) collectMarked(value[key], m, out)
  }
}

/**
 * Every value the plan marks sensitive: in a resource's before or after, or
 * a root module variable declared sensitive.
 */
function sensitiveValues(plan: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const rc of Array.isArray(plan["resource_changes"]) ? plan["resource_changes"] : []) {
    const change = isObject(rc) && isObject(rc["change"]) ? rc["change"] : {}
    collectMarked(change["before"], change["before_sensitive"], out)
    collectMarked(change["after"], change["after_sensitive"], out)
  }
  const config = isObject(plan["configuration"]) ? plan["configuration"] : {}
  const rootModule = isObject(config["root_module"]) ? config["root_module"] : {}
  const declared = isObject(rootModule["variables"]) ? rootModule["variables"] : {}
  const values = isObject(plan["variables"]) ? plan["variables"] : {}
  for (const [name, decl] of Object.entries(declared)) {
    const variable = values[name]
    if (isObject(decl) && decl["sensitive"] === true && isObject(variable)) {
      collectMarked(variable["value"], true, out)
    }
  }
  return [...out]
}

function resourceChange(
  rc: Record<string, unknown>,
  secrets: readonly string[],
): PlanResourceChange | null {
  const change = isObject(rc["change"]) ? rc["change"] : {}
  const address = typeof rc["address"] === "string" ? rc["address"] : "(unknown resource)"
  const previousAddress =
    typeof rc["previous_address"] === "string" && rc["previous_address"] !== address
      ? rc["previous_address"]
      : undefined
  const importing = isObject(change["importing"])
  let action = actionOf(change["actions"])
  // A data source read is how OpenTofu refreshes it, not a change.
  if (action === "read") return null
  if (action === null) {
    if (importing) action = "import"
    else if (previousAddress) action = "move"
    else return null
  }

  const attributes: PlanAttributeChange[] = []
  if (action !== "delete" && action !== "forget") {
    const replacePaths = Array.isArray(change["replace_paths"])
      ? change["replace_paths"].filter((p): p is (string | number)[] => Array.isArray(p))
      : []
    diffLeaves(
      (change["before"] ?? null) as Json,
      (change["after"] ?? null) as Json,
      {
        beforeSensitive: change["before_sensitive"],
        afterSensitive: change["after_sensitive"],
        afterUnknown: change["after_unknown"],
        secrets,
      },
      [],
      attributes,
      replacePaths,
    )
  }
  // An attribute that forces the replacement comes first.
  attributes.sort((a, b) => Number(!!b.forcesReplacement) - Number(!!a.forcesReplacement))

  return {
    address,
    action,
    ...(previousAddress ? { previousAddress } : {}),
    ...(importing && action !== "import" ? { importing: true } : {}),
    attributes: attributes.slice(0, MAX_ATTRIBUTES),
    ...(attributes.length > MAX_ATTRIBUTES
      ? { omittedAttributes: attributes.length - MAX_ATTRIBUTES }
      : {}),
  }
}

function countsOf(resources: readonly PlanResourceChange[]): PlanCounts {
  const counts = { ...emptyCounts() }
  for (const r of resources) {
    if (r.action === "create") counts.add++
    else if (r.action === "update") counts.change++
    else if (r.action === "delete") counts.destroy++
    else if (r.action === "replace") counts.replace++
    else if (r.action === "forget") counts.forget++
    if (r.action === "import" || r.importing) counts.import++
    if (r.action === "move" || r.previousAddress) counts.move++
  }
  return counts
}

/** The summary of one unit's plan, given the JSON `show -json` printed for it. */
export function summarizePlan(name: string, plan: Record<string, unknown>): PlanUnit {
  const secrets = sensitiveValues(plan)
  const all = (Array.isArray(plan["resource_changes"]) ? plan["resource_changes"] : [])
    .filter(isObject)
    .map((rc) => resourceChange(rc, secrets))
    .filter((r): r is PlanResourceChange => r !== null)
    .sort(
      (a, b) =>
        ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || a.address.localeCompare(b.address),
    )

  const outputs = Object.entries(isObject(plan["output_changes"]) ? plan["output_changes"] : {})
    .map(([outputName, oc]) => ({
      name: outputName,
      action: isObject(oc) ? actionOf(oc["actions"]) : null,
    }))
    .filter((o): o is { name: string; action: PlanAction } => o.action !== null)
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    name,
    planned: true,
    ...(plan["errored"] === true ? { errored: true } : {}),
    counts: countsOf(all),
    resources: all.slice(0, MAX_RESOURCES),
    ...(all.length > MAX_RESOURCES ? { omittedResources: all.length - MAX_RESOURCES } : {}),
    outputs,
  }
}

// ---------------------------------------------------------------------------
// The run report
// ---------------------------------------------------------------------------

export interface ReportEntry {
  readonly name: string
  readonly result: UnitResult
  readonly reason?: string
  readonly cause?: string
}

const UNIT_RESULTS: readonly string[] = ["succeeded", "failed", "early exit", "excluded"]

/**
 * The entries of a Terragrunt run report in JSON (schema run/report), or null
 * when `value` isn't one.
 */
export function parseRunReport(value: unknown): ReportEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const entries: ReportEntry[] = []
  for (const item of value) {
    if (!isObject(item)) return null
    const { Name, Result, Reason, Cause } = item
    if (typeof Name !== "string" || typeof Result !== "string") return null
    if (!UNIT_RESULTS.includes(Result)) return null
    entries.push({
      name: Name,
      result: Result as UnitResult,
      ...(typeof Reason === "string" && Reason ? { reason: Reason } : {}),
      ...(typeof Cause === "string" && Cause ? { cause: Cause } : {}),
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// The whole directory
// ---------------------------------------------------------------------------

/** A JSON file found in the plan directory. */
export interface PlanDirFile {
  /** Its path relative to the plan directory, with `/` separators */
  readonly relativePath: string
  /** Its parsed JSON, or why it couldn't be read */
  readonly content: { readonly json: unknown } | { readonly error: string }
}

/**
 * The name a plan file stands for: the directory it's in, as Terragrunt's
 * `--json-out-dir` mirrors each unit's path, or for a file at the top, its
 * name without `.json`.
 */
export function unitNameOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/")
  if (slash >= 0) return relativePath.slice(0, slash)
  return relativePath.replace(/\.json$/i, "")
}

/**
 * The summary of every plan and report in the plan directory, or null when
 * there's neither. JSON that is neither a plan nor a report is ignored.
 */
export function summarizePlanDir(files: readonly PlanDirFile[]): PlanSummary | null {
  const units = new Map<string, PlanUnit>()
  const reports: ReportEntry[] = []

  for (const file of files) {
    const name = unitNameOf(file.relativePath)
    if ("error" in file.content) {
      units.set(name, {
        name,
        planned: false,
        error: file.content.error,
        counts: emptyCounts(),
        resources: [],
        outputs: [],
      })
      continue
    }
    const { json } = file.content
    if (isPlanJson(json)) {
      units.set(name, summarizePlan(name, json))
      continue
    }
    const report = parseRunReport(json)
    if (report) reports.push(...report)
  }

  for (const entry of reports) {
    const unit = units.get(entry.name)
    const fromReport = {
      result: entry.result,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.cause ? { cause: entry.cause } : {}),
    }
    units.set(
      entry.name,
      unit
        ? { ...unit, ...fromReport }
        : {
            name: entry.name,
            planned: false,
            counts: emptyCounts(),
            resources: [],
            outputs: [],
            ...fromReport,
          },
    )
  }

  if (units.size === 0) return null
  const sorted = [...units.values()].sort((a, b) => a.name.localeCompare(b.name))
  return {
    units: sorted,
    totals: sorted.reduce((sum, unit) => addCounts(sum, unit.counts), emptyCounts()),
  }
}
