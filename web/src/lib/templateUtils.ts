/**
 * Shared utility functions for template rendering and output dependency tracking.
 * Used by Template, TemplateInline, useScriptExecution, GitClone, and other blocks.
 */

import type { BlockOutputs, TemplateValue } from "@/contexts/RunbookContext"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import type { OutputDependency } from "@/lib/extractTemplateDependencies"
import { normalizeBlockId } from "@/lib/utils"
import {
  isSensitiveOutput,
  maskOutputs,
  maskOutput,
  revealOutputs,
  type OutputValue,
  type OutputValues,
} from "@/lib/outputValues"

export type { OutputValue }

// --- Shared types for the new inputs/outputs architecture ---

/** A variable name from an Inputs block (e.g., "region", "env") */
export type InputName = string

/** The resolved value of an input variable (string, number, boolean, etc.) */
export type TemplateInputValue = unknown

/** A normalized block ID (e.g., "create_account") */
export type BlockId = string

/** An output key produced by a Command/Check block (e.g., "account_id") */
export type OutputName = string

/** Flattened input values. Matches {{ .inputs.<InputName> }} */
export type TemplateInputs = Record<InputName, TemplateInputValue>

/**
 * Flattened output values. Matches {{ .outputs.<BlockId>.<OutputName> }}.
 * An output the script marked `sensitive:` is a `Redacted`.
 */
export type TemplateOutputs = Record<BlockId, Record<OutputName, OutputValue>>

/** The template data context — mirrors the Go template engine's dot context */
export interface TemplateContext {
  inputs: TemplateInputs
  outputs: TemplateOutputs
}

/**
 * Outputs as a render sends them over IPC: plain strings. A `Redacted` can't
 * cross IPC (structured clone turns it into `{}`), so each render decides what
 * a sensitive output renders as: its real value (revealTemplateOutputs) when
 * the result is run or written to a file, or `<redacted>`
 * (maskTemplateOutputs) when the result is only shown.
 */
export type PlainTemplateOutputs = Record<BlockId, Record<OutputName, string>>

/** A TemplateContext whose outputs are plain strings, ready to send to the template engine. */
export interface PlainTemplateContext {
  inputs: TemplateInputs
  outputs: PlainTemplateOutputs
}

/** Every output with its real value, for a render whose result is run or written to a file. */
export function revealTemplateOutputs(outputs: TemplateOutputs): PlainTemplateOutputs {
  return Object.fromEntries(
    Object.entries(outputs).map(([blockId, values]) => [blockId, revealOutputs(values)]),
  )
}

/** Every output as it may be shown: sensitive ones as `<redacted>`. For a render that is only displayed. */
export function maskTemplateOutputs(outputs: TemplateOutputs): PlainTemplateOutputs {
  return Object.fromEntries(
    Object.entries(outputs).map(([blockId, values]) => [blockId, maskOutputs(values)]),
  )
}

/**
 * Every output except the sensitive ones. For instruction mode: it can't show
 * a sensitive value, so it asks the user to paste it, as it does for an
 * output that hasn't been produced yet.
 */
export function omitSensitiveTemplateOutputs(outputs: TemplateOutputs): PlainTemplateOutputs {
  return Object.fromEntries(
    Object.entries(outputs).map(([blockId, values]) => [
      blockId,
      Object.fromEntries(
        Object.entries(values).filter(
          (entry): entry is [OutputName, string] => !isSensitiveOutput(entry[1]),
        ),
      ),
    ]),
  )
}

/**
 * Whether any of these output references names an output that is sensitive.
 * A display render shows such an output as `<redacted>`, so a template that
 * processes its value (e.g. with `fromJson`) can fail there while the real
 * render succeeds.
 */
export function referencesSensitiveOutput(
  outputDependencies: OutputDependency[],
  allOutputs: Record<string, BlockOutputs>,
): boolean {
  return outputDependencies.some((dep) => {
    const value = allOutputs[normalizeBlockId(dep.blockId)]?.values[dep.outputName]
    return value !== undefined && isSensitiveOutput(value)
  })
}

/** A block and the specific outputs referenced from it */
export interface BlockOutput {
  blockId: BlockId
  outputNames: OutputName[]
}

/**
 * Build the variables payload for /api/boilerplate/render (full template rendering).
 * Wraps user variables under "inputs" and block outputs under "outputs" so that
 * templates using {{ .inputs.Name }} and {{ .outputs.block.key }} work correctly.
 * The backend's applyBackwardCompatibility then copies inputs to root level for
 * legacy {{ .Name }} access.
 */
export function buildRenderVariables(
  inputValues: Record<string, unknown>,
  outputs: PlainTemplateOutputs,
): Record<string, unknown> {
  return {
    inputs: { ...inputValues },
    outputs,
  }
}

/**
 * Build the TemplateValue[] payload for /api/boilerplate/render-inline.
 * Wraps both namespaces as Map-typed entries — the Go template engine navigates them
 * via {{ .inputs.X }} and {{ .outputs.X.Y }}.
 */
export function buildTemplatePayload(ctx: PlainTemplateContext): TemplateValue[] {
  return [
    { name: "inputs", type: BoilerplateVariableType.Map, value: ctx.inputs },
    { name: "outputs", type: BoilerplateVariableType.Map, value: ctx.outputs },
  ]
}

/**
 * Check if any numeric input has an empty string value.
 * This only applies to Int and Float types — when the user clears a number
 * field before typing a new value, the value is briefly "". Sending that to
 * render-inline causes a backend error (strconv.Atoi("") / ParseFloat("")).
 *
 * String types are NOT checked because "" is a valid string value.
 * Bool, List, Map, and Enum never produce empty strings from their controls.
 */
export function hasEmptyNumericInputs(inputs: TemplateValue[]): boolean {
  return inputs.some(
    (i) =>
      (i.type === BoilerplateVariableType.Int || i.type === BoilerplateVariableType.Float) &&
      i.value === "",
  )
}

/**
 * Compute which output dependencies are not yet satisfied.
 * Groups dependencies by block, normalizes IDs for lookup, and returns
 * the list of blocks/outputs that haven't been produced yet.
 *
 * An optional dependency (one the template reads only behind a `hasKey`
 * guard) needs its block to have published outputs, not the output itself.
 * It isn't listed by name, since the block may never produce it: a block
 * waited on only for optional outputs is reported with no output names.
 */
export function computeUnmetOutputDependencies(
  outputDependencies: OutputDependency[],
  allOutputs: Record<string, BlockOutputs>,
): BlockOutput[] {
  if (outputDependencies.length === 0) return []

  const byBlock = groupDependenciesByBlock(outputDependencies)
  const unmet: BlockOutput[] = []

  for (const [blockId, outputs] of byBlock) {
    const values = allOutputs[normalizeBlockId(blockId)]?.values
    const required = [...outputs].filter(([, optional]) => !optional).map(([name]) => name)
    const missingOutputs = required.filter((name) => !values || !(name in values))
    const waitsOnBlock = required.length < outputs.size && !hasPublishedOutputs(values)
    if (missingOutputs.length > 0 || waitsOnBlock) {
      // Preserve the original blockId for display
      unmet.push({ blockId, outputNames: missingOutputs })
    }
  }

  return unmet
}

/**
 * Whether a block has published outputs. Blocks withdraw their outputs by
 * publishing an empty map (a failed Command, a reset GitClone, a cleared
 * DirPicker) or only internal `__` markers (a signed-out AwsAuth or
 * GoogleAuth publishes `__AUTHENTICATED: "false"`), so neither counts. A
 * Command that succeeded without writing any outputs also leaves an empty
 * map, and can't be told apart from a failed one.
 */
function hasPublishedOutputs(values: OutputValues | undefined): boolean {
  return values !== undefined && Object.keys(values).some((key) => !key.startsWith("__"))
}

/**
 * Flatten block outputs by stripping the .values wrapper.
 * Transforms Record<string, BlockOutputs> → TemplateOutputs.
 * Used inside useTemplateDependencies to provide callers with the flat format
 * matching {{ .outputs.*.* }} template expressions.
 */
export function flattenBlockOutputs(allOutputs: Record<string, BlockOutputs>): TemplateOutputs {
  const result: TemplateOutputs = {}
  for (const [blockId, data] of Object.entries(allOutputs)) {
    result[blockId] = data.values
  }
  return result
}

/**
 * Resolve a potentially nested path (e.g., "_module.source") against an object.
 * Returns the value at the path, or undefined if any segment is missing. Like
 * the template engine's map lookup, only own properties of plain objects count:
 * `tags.constructor` or `list.length` is missing, not an inherited or built-in
 * member.
 */
function resolveNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".")
  let current: unknown = obj
  for (const segment of segments) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * The value an input reference path (`region`, `tags.env`) resolves to: a
 * top-level key of that exact name, else the nested value (see
 * resolveNestedValue). Undefined when the engine would find no such key.
 */
export function resolveInputPath(inputs: TemplateInputs, path: InputName): unknown {
  return Object.hasOwn(inputs, path) ? inputs[path] : resolveNestedValue(inputs, path)
}

/**
 * Returns input dependency names that don't have values yet.
 * Supports nested paths (e.g., "_module.source") for values injected
 * as nested objects by upstream blocks.
 * An empty string counts as no value, except for the inputs in `mayBeEmpty`
 * (see inputsThatMayBeEmpty).
 * Returns an empty array when deps is empty (no dependencies to check).
 */
export function computeUnmetInputDependencies(
  deps: InputName[],
  inputs: TemplateInputs,
  mayBeEmpty: ReadonlySet<InputName> = new Set(),
): InputName[] {
  return deps.filter((name) => {
    const value = name.includes(".")
      ? resolveNestedValue(inputs as Record<string, unknown>, name)
      : inputs[name]
    if (value === "") return !mayBeEmpty.has(name)
    return value === undefined || value === null
  })
}

/**
 * The inputs a block may run with while they're empty: those whose variable
 * declares a `default` and isn't required. A runbook makes a field optional
 * with `default: ""`. When several Inputs blocks declare a variable, the last
 * one decides, as it does for the values.
 */
export function inputsThatMayBeEmpty(
  configs: ReadonlyArray<BoilerplateConfig | undefined>,
): Set<InputName> {
  const names = new Set<InputName>()
  for (const config of configs) {
    for (const variable of config?.variables ?? []) {
      if (variable.default !== undefined && !variable.required) names.add(variable.name)
      else names.delete(variable.name)
    }
  }
  return names
}

/**
 * A plain value action: `{{ .inputs.X }}` or `{{ .outputs.X.Y }}`, optionally
 * piped through functions (`{{ .inputs.X | upper }}`). A reference inside
 * template logic (`{{ if .inputs.X }}`, a function argument) doesn't match.
 */
const VALUE_REFERENCE_PATTERN =
  /\{\{-?\s*\.(inputs|outputs)\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)\s*(?:\|[^}]*)?\s*-?\}\}/g

/**
 * The distinct input paths `text` uses as plain value actions: exactly the
 * `{{ .inputs.* }}` references resolveValueReferences substitutes. An input
 * referenced only inside template logic is not included.
 */
export function extractInputValueReferences(text: string): InputName[] {
  const names = new Set<InputName>()
  for (const [, namespace, path] of text.matchAll(VALUE_REFERENCE_PATTERN)) {
    // Both groups are required by the pattern.
    if (namespace === "inputs") names.add(path!)
  }
  return [...names]
}

/**
 * Resolve the template expressions in a string shown on screen or sent as text,
 * such as a title, a status message, a form field or PR text. Client-side
 * resolver for blocks that don't go through the Go template engine.
 *
 * It evaluates `{{ if }}` / `{{ else if }}` / `{{ else }}` / `{{ end }}` whose
 * condition is a reference or `eq`/`ne` of a reference and a quoted string,
 * then substitutes `{{ .inputs.X }}` and `{{ .outputs.X.Y }}`. A value that
 * doesn't exist yet is empty in a condition, so the `else` branch shows until
 * the block that publishes it runs.
 *
 * Its results are shown on screen or sent where a secret doesn't belong (a PR
 * title or body), so a sensitive output resolves to `<redacted>`, never its
 * real value, and compares as `<redacted>` in a condition.
 */
export function resolveTemplateReferences(text: string, ctx: TemplateContext): string {
  if (!text) return text
  return resolveValueReferences(resolveConditionals(text, ctx), ctx)
}

/**
 * Substitute `{{ .inputs.X }}` and `{{ .outputs.X.Y }}` value references only,
 * leaving template logic as written. A reference with no value stays as
 * written, in backticks.
 */
export function resolveValueReferences(text: string, ctx: TemplateContext): string {
  if (!text) return text
  return text.replace(VALUE_REFERENCE_PATTERN, (match, namespace, path) => {
    if (namespace === "inputs") {
      // A dotted path (e.g. a Map input's `{{ .inputs.tags.env }}`) resolves
      // through nested objects, like computeUnmetInputDependencies.
      const value = resolveInputPath(ctx.inputs, path)
      if (value == null) return `\`${match}\``
      if (typeof value === "string") return value
      if (typeof value === "number" || typeof value === "boolean") return String(value)
      // A whole List or Map input, which would otherwise print as "[object Object]"
      return JSON.stringify(value)
    }
    if (namespace === "outputs") {
      const value = lookupOutput(ctx, path)
      return value !== undefined ? maskOutput(value) : `\`${match}\``
    }
    return `\`${match}\``
  })
}

// --- Internal helpers ---

function lookupOutput(ctx: TemplateContext, path: string): OutputValue | undefined {
  const dotIdx = path.indexOf(".")
  if (dotIdx <= 0) return undefined
  return ctx.outputs[normalizeBlockId(path.slice(0, dotIdx))]?.[path.slice(dotIdx + 1)]
}

/** `{{ if … }}`, `{{ else if … }}`, `{{ else }}` and `{{ end }}` actions, with optional trim markers. */
const CONDITIONAL_ACTION_PATTERN = /\{\{(-?)\s*(if|else if|else|end)\b([^}]*?)\s*(-?)\}\}/g

/** A condition operand: an input or output reference, or a double-quoted string. */
const OPERAND = String.raw`(\.(?:inputs|outputs)\.[a-zA-Z0-9_.-]+|"(?:[^"\\]|\\.)*")`
const COMPARISON_PATTERN = new RegExp(String.raw`^(eq|ne)\s+${OPERAND}\s+${OPERAND}$`)
const BARE_REFERENCE_PATTERN = new RegExp(String.raw`^${OPERAND}$`)

/** An operand's value as the condition sees it: a missing value is "". */
function operandValue(operand: string, ctx: TemplateContext): string {
  if (operand.startsWith('"')) return JSON.parse(operand) as string
  const [, namespace, ...rest] = operand.split(".")
  const path = rest.join(".")
  if (namespace === "inputs") {
    const value = resolveInputPath(ctx.inputs, path)
    if (value == null) return ""
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return JSON.stringify(value)
  }
  const value = lookupOutput(ctx, path)
  return value === undefined ? "" : maskOutput(value)
}

/** null when the condition isn't one this resolver understands. */
function evaluateCondition(condition: string, ctx: TemplateContext): boolean | null {
  const comparison = COMPARISON_PATTERN.exec(condition)
  if (comparison) {
    const equal = operandValue(comparison[2]!, ctx) === operandValue(comparison[3]!, ctx)
    return comparison[1] === "eq" ? equal : !equal
  }
  const bare = BARE_REFERENCE_PATTERN.exec(condition)
  if (bare) return operandValue(bare[1]!, ctx) !== ""
  return null
}

interface ConditionalAction {
  start: number
  end: number
  trimLeft: boolean
  trimRight: boolean
  keyword: "if" | "else if" | "else" | "end"
  condition: string
}

/**
 * Evaluate the `{{ if }}` blocks in `text`, innermost first. A block whose
 * condition this resolver doesn't understand, or that isn't closed, is left as
 * written, as are the actions around it.
 */
function resolveConditionals(text: string, ctx: TemplateContext): string {
  for (;;) {
    const actions: ConditionalAction[] = [...text.matchAll(CONDITIONAL_ACTION_PATTERN)].map(
      (m) => ({
        start: m.index,
        end: m.index + m[0].length,
        trimLeft: m[1] === "-",
        trimRight: m[4] === "-",
        keyword: m[2] as ConditionalAction["keyword"],
        condition: m[3]!.trim(),
      }),
    )
    // The innermost block: the last `if` before the first `end` that follows it.
    const endIdx = actions.findIndex((a) => a.keyword === "end")
    if (endIdx < 0) return text
    let ifIdx = -1
    for (let i = endIdx - 1; i >= 0; i--) {
      if (actions[i]!.keyword === "if") {
        ifIdx = i
        break
      }
    }
    if (ifIdx < 0) return text
    const block = actions.slice(ifIdx, endIdx + 1)
    const resolved = evaluateBlock(text, block, ctx)
    if (resolved === null) return text
    const first = block[0]!
    const last = block[block.length - 1]!
    let before = text.slice(0, first.start)
    let after = text.slice(last.end)
    if (first.trimLeft) before = before.trimEnd()
    if (last.trimRight) after = after.trimStart()
    text = before + resolved + after
  }
}

/** The text of the branch the block takes, or null if a condition isn't understood. */
function evaluateBlock(
  text: string,
  block: ConditionalAction[],
  ctx: TemplateContext,
): string | null {
  for (let i = 0; i < block.length - 1; i++) {
    const action = block[i]!
    const next = block[i + 1]!
    let taken: boolean | null
    if (action.keyword === "else") taken = true
    else taken = evaluateCondition(action.condition, ctx)
    if (taken === null) return null
    if (taken) {
      let body = text.slice(action.end, next.start)
      if (action.trimRight) body = body.trimStart()
      if (next.trimLeft) body = body.trimEnd()
      return body
    }
  }
  return ""
}

/**
 * Group output dependencies by block ID, mapping each output name to whether
 * it is optional. An output referenced both guarded and unguarded is
 * required.
 */
function groupDependenciesByBlock(
  dependencies: OutputDependency[],
): Map<string, Map<string, boolean>> {
  const grouped = new Map<string, Map<string, boolean>>()

  for (const dep of dependencies) {
    const existing = grouped.get(dep.blockId) ?? new Map<string, boolean>()
    existing.set(dep.outputName, (existing.get(dep.outputName) ?? true) && dep.optional === true)
    grouped.set(dep.blockId, existing)
  }

  return grouped
}
