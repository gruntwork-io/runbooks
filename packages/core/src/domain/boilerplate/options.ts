/**
 * The options of a dropdown (`enum` `options`) or multi-select picker (`list`
 * `x-options`).
 *
 * An option is a string, shown and stored as it is, or `{ value, label }`,
 * shown as its label and stored as its value. A list of them can be written in
 * the YAML, or come from a block's output: an output reference such as
 * `{{ fromJson .outputs.list_regions.regions }}` whose output is a JSON array
 * of options.
 *
 * The form (web/) and the `runbooks test` CLI both use this module, so an
 * option list means the same to both. The renderer bundles it directly, so it
 * must stay free of Node and Electron imports.
 */

import { isTemplateString } from "./templateString.ts"

/** An option with the text it is shown as. */
export interface OptionItem {
  value: string
  label: string
}

/** The block output a variable's options come from, as the YAML references it. */
export interface OptionsReference {
  /** The reference as written, e.g. `{{ fromJson .outputs.list_regions.regions }}`. */
  expression: string
  /** The block id as written. */
  blockId: string
  outputName: string
}

/**
 * The variable fields that hold its options: their values in `options` and,
 * when any option's label differs from its value, the labels by value in
 * `optionLabels`. `optionsFrom` names the output they come from instead;
 * `options` then holds them only once that output has been read.
 */
export interface OptionFields {
  options?: string[]
  optionLabels?: Record<string, string>
  optionsFrom?: OptionsReference
}

/**
 * A whole value that is just `{{ fromJson .outputs.<block>.<output> }}` or
 * `{{ .outputs.<block>.<output> }}`. The output name is an identifier, as the
 * template-reference extractor reads it (see document/templateReferences.ts).
 */
const OPTIONS_REFERENCE_RE =
  /^\s*\{\{-?\s*(?:fromJson\s+)?\.outputs\.([a-zA-Z0-9_-]+)\.(\w+)\s*-?\}\}\s*$/

/** The output a string of options refers to, or undefined when it isn't one output reference. */
export function parseOptionsReference(expression: string): OptionsReference | undefined {
  const match = OPTIONS_REFERENCE_RE.exec(expression)
  if (!match) return undefined
  return { expression: expression.trim(), blockId: match[1]!, outputName: match[2]! }
}

/**
 * One option as written: a string, or `{ value, label? }`. With `scalars`, a
 * number or boolean (what YAML makes of `1` or `true`) is taken as its string.
 */
function optionItem(raw: unknown, scalars = false): OptionItem | undefined {
  if (typeof raw === "string") return { value: raw, label: raw }
  if (scalars && (typeof raw === "number" || typeof raw === "boolean")) {
    return { value: String(raw), label: String(raw) }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { value, label } = raw as { value?: unknown; label?: unknown }
    if (typeof value !== "string") return undefined
    if (label === undefined) return { value, label: value }
    return typeof label === "string" ? { value, label } : undefined
  }
  return undefined
}

/**
 * The options in a list written in the YAML. An entry that isn't a string or
 * `{ value, label }` is left out, as an invalid entry elsewhere in the config
 * is, with a warning. An enum's `options` has always taken numbers and
 * booleans as their strings (`scalars`); a list's `x-options` hasn't.
 */
export function staticOptionItems(
  raw: readonly unknown[],
  where: string,
  scalars: boolean,
): OptionItem[] {
  const items: OptionItem[] = []
  raw.forEach((entry, index) => {
    const item = optionItem(entry, scalars)
    if (item) items.push(item)
    else {
      console.warn(
        `[boilerplate config] ${where}[${index}] must be a string or { value, label }; ignoring it.`,
      )
    }
  })
  return items
}

/** The option fields for a list of options: their values, and their labels when any differs. */
export function optionFields(
  items: readonly OptionItem[],
): Pick<OptionFields, "options" | "optionLabels"> {
  const fields: Pick<OptionFields, "options" | "optionLabels"> = {
    options: items.map((item) => item.value),
  }
  if (items.some((item) => item.label !== item.value)) {
    fields.optionLabels = Object.fromEntries(items.map((item) => [item.value, item.label]))
  }
  return fields
}

/** A variable's options with the text each is shown as. */
export function optionItems(variable: OptionFields): OptionItem[] {
  return (variable.options ?? []).map((option) => {
    const value = String(option)
    return { value, label: variable.optionLabels?.[value] ?? value }
  })
}

/** What an output reference reads: the options, or why the output can't be used as them. */
export type OutputOptions = { ok: true; items: OptionItem[] } | { ok: false; error: string }

/** How an error about a variable's options names where they come from. */
export function describeOptionsSource(reference: OptionsReference): string {
  return `output "${reference.outputName}" of block "${reference.blockId}"`
}

const OPTIONS_SHAPE = 'a JSON array of strings or { "value", "label" } objects'

/**
 * The options in an output's value: a JSON array whose entries are strings or
 * `{ value, label }` objects. `undefined` is an output the block hasn't
 * produced. An empty array is a valid, empty list.
 */
export function parseOutputOptions(
  reference: OptionsReference,
  outputValue: string | undefined,
): OutputOptions {
  const source = describeOptionsSource(reference)
  if (outputValue === undefined) {
    return { ok: false, error: `The options come from ${source}, which hasn't been produced.` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(outputValue)
  } catch {
    return {
      ok: false,
      error: `The options come from ${source}, which must be ${OPTIONS_SHAPE}, but it isn't valid JSON.`,
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `The options come from ${source}, which must be ${OPTIONS_SHAPE}, but it is ${describeJson(parsed)}.`,
    }
  }
  const items: OptionItem[] = []
  for (const [index, entry] of parsed.entries()) {
    const item = optionItem(entry)
    if (!item) {
      return {
        ok: false,
        error: `The options come from ${source}, which must be ${OPTIONS_SHAPE}, but entry ${index + 1} is ${describeJson(entry)}.`,
      }
    }
    items.push(item)
  }
  return { ok: true, items }
}

/** A JSON value as an error message names it. */
function describeJson(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "object") return "an object without a string value"
  return `a ${typeof value}`
}

/**
 * The error on a value that isn't one of a variable's options, or undefined.
 * Only for options that come from an output, once they've been read: a static
 * list is enforced by its control, as it always was. A template value (a
 * linked default) becomes an option only when the render resolves it, so it
 * isn't checked here.
 */
export function optionMembershipError(
  variable: OptionFields & { type?: string },
  value: unknown,
): string | undefined {
  if (!variable.optionsFrom || !variable.options) return undefined
  const allowed = new Set(variable.options.map(String))
  if (variable.type === "enum") {
    if (value === undefined || value === null || value === "" || isTemplateString(value))
      return undefined
    const text = typeof value === "string" ? value : JSON.stringify(value)
    return allowed.has(text) ? undefined : `"${text}" isn't one of the options.`
  }
  if (variable.type === "list" && Array.isArray(value)) {
    const outside = value.filter((item) => !isTemplateString(item) && !allowed.has(String(item)))
    if (outside.length === 0) return undefined
    return outside.length === 1
      ? `"${String(outside[0])}" isn't one of the options.`
      : `${outside.map((item) => `"${String(item)}"`).join(", ")} aren't among the options.`
  }
  return undefined
}
