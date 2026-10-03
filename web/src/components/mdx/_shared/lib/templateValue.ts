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
import { isTemplateString } from "../../../../../../src/domain/boilerplate/templateString"

const ACTION_RE = /\{\{(.*?)\}\}/gs

/** A whole action that is just `.Name` or `.inputs.Name`. */
const PLAIN_REF_RE = /^\.(?:inputs\.)?([A-Za-z_]\w*)$/
/** A `.A.B.C` field chain that starts at the template's root (not `$x.A` or `(…).A`). */
const FIELD_CHAIN_RE = /(?<![\w$)\]])\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g
/** Go string, raw string and char literals, whose contents are never variable references. */
const LITERAL_RE = /"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'/g

export type TemplateSegment = { kind: "text"; text: string } | { kind: "ref"; name: string }

export type ParsedTemplateValue =
  /** Literal text and plain variable references, in order. */
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
 * action is a plain `{{ .Name }}` / `{{ .inputs.Name }}`; otherwise report it
 * as computed, with the variables it uses. Whitespace removed by `{{-` / `-}}`
 * trim markers is dropped from the text, as it is from the rendered value.
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
    let action = match[1]!
    const trimBefore = /^-\s/.test(action)
    const trimAfter = /\s-$/.test(action)
    if (trimBefore) action = action.slice(1)
    if (trimAfter) action = action.slice(0, -1)
    action = action.trim()

    let text = expr.slice(textStart, match.index)
    if (trimLeadingText) text = text.trimStart()
    if (trimBefore) text = text.trimEnd()
    addText(text)
    textStart = match.index + match[0].length
    trimLeadingText = trimAfter

    const name = PLAIN_REF_RE.exec(action)?.[1]
    if (isVariableName(name)) {
      segments.push({ kind: "ref", name })
      addRef(name)
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

/** Whether a value is a template, or holds one as a list item, map key or map value. */
export function containsTemplateValue(value: unknown): boolean {
  if (isTemplateValue(value)) return true
  if (Array.isArray(value)) return value.some(containsTemplateValue)
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => isTemplateValue(k) || containsTemplateValue(v))
  }
  return false
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
