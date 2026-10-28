/**
 * Helpers for showing a template-valued input (a boilerplate `default:` such
 * as `{{ .SecurityModulesVersion }}` or `aws-sso@{{ .EmailDomainName }}`)
 * without printing the raw Go-template syntax.
 *
 * Display only: the form keeps the raw expression as the value, and the main
 * process resolves it against the other inputs when it renders (see
 * resolveInputTemplates in src/domain/boilerplate/flattenInputs.ts). The form
 * asks main for that same resolution as values change (see
 * useResolvedTemplateValues) and shows what a value comes to when it's known.
 */

import { formatVariableLabel } from "./formatVariableLabel"
import {
  extractTemplateDependenciesFromString,
  splitDependencies,
  type OutputDependency,
} from "@/lib/extractTemplateDependencies"
import { isTemplateString } from "../../../../../../src/domain/boilerplate/templateString"
import { outputRef, type OutputRef } from "./outputOverrides"

const ACTION_RE = /\{\{(.*?)\}\}/gs

/** A whole action that is just `.Name` or `.inputs.Name`. */
const PLAIN_REF_RE = /^\.(?:inputs\.)?([A-Za-z_]\w*)$/
/** A whole action that is just `.outputs.<block>.<name>`, matching the dependency extractor's reference. */
const OUTPUT_REF_RE = /^\.outputs\.([a-zA-Z0-9_-]+)\.(\w+)$/
/** A `.A.B.C` field chain that starts at the template's root (not `$x.A` or `(…).A`). */
const FIELD_CHAIN_RE = /(?<![\w$)\]])\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g
/** Go string, raw string and char literals, whose contents are never variable references. */
const LITERAL_RE = /"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'/g

/**
 * Part of a template value: literal text, or a plain reference to a variable
 * or a block's output. A reference has its `action` as written, without trim
 * markers.
 */
export type TemplateSegment =
  | { kind: "text"; text: string }
  | { kind: "ref"; name: string; action: string }
  | { kind: "output"; ref: OutputRef; action: string }

/** A reference in a template value, which the form shows as a chip. */
export type TemplateReference = Exclude<TemplateSegment, { kind: "text" }>

export type ParsedTemplateValue =
  /** Literal text and plain references, in order. */
  | { kind: "segments"; segments: TemplateSegment[] }
  /** Anything more (conditionals, pipelines, functions): only the variables it uses. */
  | { kind: "computed"; refs: string[] }

/** The same test main uses to pick the values it resolves, so a value shown as linked is exactly one main resolves. */
export function isTemplateValue(value: unknown): value is string {
  return isTemplateString(value)
}

/** A form variable name, not a namespace or a boilerplate internal like `__each__`. */
function isVariableName(name: string | undefined): name is string {
  return !!name && name !== "inputs" && name !== "outputs" && !name.startsWith("__")
}

/** The variables an action refers to: the first segment of each root field chain, or the one after `.inputs`. */
function variablesIn(action: string): string[] {
  const names: string[] = []
  for (const [, chain] of action.replace(LITERAL_RE, '""').matchAll(FIELD_CHAIN_RE)) {
    const [first, second] = chain!.split(".")
    if (first === "outputs") continue
    const name = first === "inputs" ? second : first
    if (isVariableName(name)) names.push(name)
  }
  return names
}

/**
 * Split a template value into literal text and plain references when every
 * action is a plain `{{ .Name }}` / `{{ .inputs.Name }}` /
 * `{{ .outputs.<block>.<name> }}`; otherwise report it as computed, with the
 * variables it uses. Whitespace removed by `{{-` / `-}}` trim markers is
 * dropped from the text, as it is from the rendered value.
 */
export function parseTemplateValue(expr: string): ParsedTemplateValue {
  const segments: TemplateSegment[] = []
  const refs: string[] = []
  let computed = false
  let textStart = 0
  let trimLeadingText = false

  const addRef = (name: string) => {
    if (!refs.includes(name)) refs.push(name)
  }
  const addText = (text: string) => {
    if (text) segments.push({ kind: "text", text })
  }

  for (const match of expr.matchAll(ACTION_RE)) {
    let body = match[1]!
    const trimBefore = /^-\s/.test(body)
    const trimAfter = /\s-$/.test(body)
    if (trimBefore) body = body.slice(1)
    if (trimAfter) body = body.slice(0, -1)
    const action = body.trim()

    let text = expr.slice(textStart, match.index)
    if (trimLeadingText) text = text.trimStart()
    if (trimBefore) text = text.trimEnd()
    addText(text)
    textStart = match.index + match[0].length
    trimLeadingText = trimAfter

    const name = PLAIN_REF_RE.exec(action)?.[1]
    const output = OUTPUT_REF_RE.exec(action)
    if (isVariableName(name)) {
      segments.push({ kind: "ref", name, action: `{{${body}}}` })
      addRef(name)
    } else if (output) {
      segments.push({
        kind: "output",
        ref: outputRef(output[1]!, output[2]!),
        action: `{{${body}}}`,
      })
    } else {
      computed = true
      variablesIn(action).forEach(addRef)
    }
  }

  const rest = expr.slice(textStart)
  addText(trimLeadingText ? rest.trimStart() : rest)

  return computed ? { kind: "computed", refs } : { kind: "segments", segments }
}

/**
 * A plain-text description of a template value, with variable names written
 * the way the form labels them: "Same as Security Modules Version",
 * "Based on Repo Base URL, Infra Modules Repo Name", or "Set automatically".
 */
export function summarizeTemplateValue(expr: string): string {
  const parsed = parseTemplateValue(expr)
  let refs: string[]
  if (parsed.kind === "segments") {
    const [first] = parsed.segments
    if (parsed.segments.length === 1 && first?.kind === "ref")
      return `Same as ${formatVariableLabel(first.name)}`
    refs = [...new Set(parsed.segments.flatMap((s) => (s.kind === "ref" ? [s.name] : [])))]
  } else {
    refs = parsed.refs
  }
  return refs.length > 0
    ? `Based on ${refs.map(formatVariableLabel).join(", ")}`
    : "Set automatically"
}

/**
 * The key a value entered for a chip is kept under: `inputs.<Name>` for a
 * variable, the reference's `outputs.<block_id>.<name>` for a block output.
 * Every chip for the same reference in a field shares it.
 */
export function chipKey(reference: TemplateReference): string {
  return reference.kind === "ref" ? `inputs.${reference.name}` : reference.ref.fullPath
}

/**
 * The key a value entered for a whole template string is kept under: one
 * the form shows as a single chip, as it does a computed or sensitive value.
 */
export function wholeValueKey(expr: string): string {
  return `=${expr}`
}

/** Template text that renders as `text`: a `{{` in it would start an action. */
function templateText(text: string): string {
  return text.replaceAll("{{", '{{ "{{" }}')
}

/** A template string with the entered values in place of its chips, or the string itself. */
function withEnteredText(expr: string, entered: Readonly<Record<string, string>>): string {
  if (!isTemplateValue(expr)) return expr
  const whole = entered[wholeValueKey(expr)]
  if (whole !== undefined) return templateText(whole)

  const parsed = parseTemplateValue(expr)
  if (parsed.kind === "computed") return expr
  const references = parsed.segments.filter((segment) => segment.kind !== "text")
  if (!references.some((reference) => entered[chipKey(reference)] !== undefined)) return expr

  // Trim markers come off the actions kept: their whitespace is gone already.
  return parsed.segments
    .map((segment) => {
      if (segment.kind === "text") return segment.text
      const value = entered[chipKey(segment)]
      return value === undefined ? segment.action : templateText(value)
    })
    .join("")
}

/**
 * A form value with values entered by hand in place of the chips they're for,
 * by chip key (see chipKey, wholeValueKey), in each template string it holds:
 * the value itself, or its list items, map keys and map values. The rest of
 * the value is left as it is.
 */
export function withEnteredValues(
  value: unknown,
  entered: Readonly<Record<string, string>>,
): unknown {
  if (typeof value === "string") return withEnteredText(value, entered)
  if (Array.isArray(value)) return value.map((item) => withEnteredValues(item, entered))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        withEnteredText(k, entered),
        withEnteredValues(v, entered),
      ]),
    )
  }
  return value
}

/** The keys of the chips a form value's template strings show, by both kinds of key. */
export function chipKeysIn(value: unknown): Set<string> {
  const keys = new Set<string>()
  for (const expr of templateStringsIn(value)) {
    keys.add(wholeValueKey(expr))
    const parsed = parseTemplateValue(expr)
    if (parsed.kind === "computed") continue
    for (const segment of parsed.segments) {
      if (segment.kind !== "text") keys.add(chipKey(segment))
    }
  }
  return keys
}

/** Whether a value is a template, or holds one as a list item, map key or map value. */
export function containsTemplateValue(value: unknown): boolean {
  if (isTemplateValue(value)) return true
  if (Array.isArray(value)) return value.some(containsTemplateValue)
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => isTemplateValue(k) || containsTemplateValue(v))
  }
  return false
}

/** Every template string in a value: the value itself, or its list items, map keys and map values. */
function templateStringsIn(value: unknown): string[] {
  if (isTemplateValue(value)) return [value]
  if (Array.isArray(value)) return value.flatMap(templateStringsIn)
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...templateStringsIn(k),
      ...templateStringsIn(v),
    ])
  }
  return []
}

/** The block outputs a value's templates use, wherever in the value they are. */
export function outputDependenciesIn(value: unknown): OutputDependency[] {
  return splitDependencies(extractTemplateDependenciesFromString(...templateStringsIn(value)))
    .outputs
}

/**
 * The text to show for what a template value resolved to, or undefined to
 * keep showing its tokens: it hasn't resolved (it is still a template, or no
 * result has arrived), or it came to "", which would leave nothing to show.
 */
export function resolvedValueText(resolved: unknown): string | undefined {
  return typeof resolved === "string" && resolved !== "" && !isTemplateValue(resolved)
    ? resolved
    : undefined
}

/**
 * A list's resolved value item by item, or [] when it isn't a list of the
 * same length.
 */
export function resolvedItems(items: readonly unknown[], resolved: unknown): readonly unknown[] {
  return Array.isArray(resolved) && resolved.length === items.length ? resolved : []
}

/**
 * A map's resolved value as entries lined up with the map's own, or [] when
 * they don't line up: two keys came to the same text and merged, or a key
 * came to a number-like text, which an object lists first.
 */
export function resolvedEntries(
  entries: ReadonlyArray<[string, unknown]>,
  resolved: unknown,
): ReadonlyArray<[string, unknown]> {
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return []
  const resolvedList = Object.entries(resolved)
  const linedUp =
    resolvedList.length === entries.length &&
    entries.every(([key], i) => isTemplateValue(key) || resolvedList[i]![0] === key)
  return linedUp ? resolvedList : []
}
