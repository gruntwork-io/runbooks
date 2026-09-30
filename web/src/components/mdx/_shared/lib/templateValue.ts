/**
 * Helpers for showing a template-valued input (a boilerplate `default:` such
 * as `{{ .SecurityModulesVersion }}` or `aws-sso@{{ .EmailDomainName }}`)
 * without printing the raw Go-template syntax.
 *
 * Display only: the form keeps the raw expression as the value, and the main
 * process resolves it against the other inputs when it renders (see
 * resolveInputTemplates in src/domain/boilerplate/flattenInputs.ts).
 */

import { formatVariableLabel } from './formatVariableLabel'

/** Same pattern as TEMPLATE_EXPR_RE in src/domain/boilerplate/flattenInputs.ts, so a value shown as linked is exactly one main resolves. */
const TEMPLATE_EXPR_RE = /\{\{.*?\}\}/s
const ACTION_RE = /\{\{(.*?)\}\}/gs

/** A whole action that is just `.Name` or `.inputs.Name`. */
const PLAIN_REF_RE = /^\.(?:inputs\.)?([A-Za-z_]\w*)$/
/** A `.A.B.C` field chain that starts at the template's root (not `$x.A` or `(…).A`). */
const FIELD_CHAIN_RE = /(?<![\w$)\]])\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g
/** Go string, raw string and char literals, whose contents are never variable references. */
const LITERAL_RE = /"(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*'/g

export type TemplateSegment =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; name: string }

export type ParsedTemplateValue =
  /** Literal text and plain variable references, in order. */
  | { kind: 'segments'; segments: TemplateSegment[] }
  /** Anything more (conditionals, pipelines, functions): only the variables it uses. */
  | { kind: 'computed'; refs: string[] }

export function isTemplateValue(value: unknown): value is string {
  return typeof value === 'string' && TEMPLATE_EXPR_RE.test(value)
}

/** A form variable name, not a namespace or a boilerplate internal like `__each__`. */
function isVariableName(name: string | undefined): name is string {
  return !!name && name !== 'inputs' && name !== 'outputs' && !name.startsWith('__')
}

/** The variables an action refers to: the first segment of each root field chain, or the one after `.inputs`. */
function variablesIn(action: string): string[] {
  const names: string[] = []
  for (const [, chain] of action.replace(LITERAL_RE, '""').matchAll(FIELD_CHAIN_RE)) {
    const [first, second] = chain.split('.')
    if (first === 'outputs') continue
    const name = first === 'inputs' ? second : first
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
    if (text) segments.push({ kind: 'text', text })
  }

  for (const match of expr.matchAll(ACTION_RE)) {
    let action = match[1]
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
      segments.push({ kind: 'ref', name })
      addRef(name)
    } else {
      computed = true
      variablesIn(action).forEach(addRef)
    }
  }

  const rest = expr.slice(textStart)
  addText(trimLeadingText ? rest.trimStart() : rest)

  return computed ? { kind: 'computed', refs } : { kind: 'segments', segments }
}

/**
 * A plain-text description of a template value, with variable names written
 * the way the form labels them: "Same as Security Modules Version",
 * "Based on Repo Base URL, Infra Modules Repo Name", or "Set automatically".
 */
export function summarizeTemplateValue(expr: string): string {
  const parsed = parseTemplateValue(expr)
  let refs: string[]
  if (parsed.kind === 'segments') {
    const [first] = parsed.segments
    if (parsed.segments.length === 1 && first.kind === 'ref') return `Same as ${formatVariableLabel(first.name)}`
    refs = [...new Set(parsed.segments.flatMap(s => (s.kind === 'ref' ? [s.name] : [])))]
  } else {
    refs = parsed.refs
  }
  return refs.length > 0 ? `Based on ${refs.map(formatVariableLabel).join(', ')}` : 'Set automatically'
}
