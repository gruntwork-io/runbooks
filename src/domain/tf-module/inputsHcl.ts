/**
 * A <TfModule> block's inputs written as HCL attributes, for a template to
 * place in a `terragrunt.hcl` inputs map or a `module` block. The block
 * writes the values itself, so a template author never encodes one, and
 * text from a form, a lookup or another block is always a literal string,
 * never an interpolation HCL would evaluate.
 */
import type { TfModuleInputKind } from "./types.ts"

/** What the encoding needs to know about an input. */
export interface InputDefault {
  readonly name: string
  readonly kind: TfModuleInputKind
  readonly hasDefault: boolean
  readonly default?: unknown
}

const IDENTIFIER = /^[A-Za-z_][\w-]*$/

/** HCL's escape for each character a quoted string can't hold as it is. */
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
}

const escapeChar = (char: string) => {
  const escape = ESCAPES[char]
  if (escape) return escape
  const code = char.codePointAt(0)!
  return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : char
}

/**
 * A string as an HCL quoted string. `${` and `%{` start a template sequence
 * in HCL, so they're doubled to stay literal.
 */
export function hclString(text: string): string {
  const escaped = Array.from(text, escapeChar).join("")
  return `"${escaped.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{")}"`
}

const hclKey = (key: string) => (IDENTIFIER.test(key) ? key : hclString(key))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isScalar = (value: unknown) => !isRecord(value) && !Array.isArray(value)

/**
 * A value as an HCL expression, laid out the way `hcl fmt` leaves it: a
 * list of scalars on one line, a map with one attribute per line, and a
 * list of collections with one item per line. Continuation lines are
 * indented from `indent`.
 */
export function hclValue(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return hclString(value)
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null"
  if (typeof value === "boolean") return String(value)
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    if (value.every(isScalar)) return `[${value.map((item) => hclValue(item)).join(", ")}]`
    return `[\n${value.map((item) => `${inner}${hclValue(item, inner)},\n`).join("")}${indent}]`
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return "{}"
    const lines = entries.map(([key, item]) => `${inner}${hclKey(key)} = ${hclValue(item, inner)}`)
    return `{\n${lines.join("\n")}\n${indent}}`
  }
  // A form value is JSON, so nothing else reaches here.
  return "null"
}

/** A value with its maps' keys sorted, so equal values compare equal as JSON. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0)

/**
 * Whether the module would see the value as its own default, so the code
 * needn't set it: the same value, or, for an input whose default is null,
 * an empty one, since a form field can't hold null.
 */
export function isDefault(input: InputDefault, value: unknown): boolean {
  if (!input.hasDefault) return false
  if (input.default === null || input.default === undefined) return isEmpty(value)
  return JSON.stringify(canonical(value)) === JSON.stringify(canonical(input.default))
}

/**
 * The inputs the code sets, one attribute per line, indented two spaces:
 * every required input, and each other input whose value isn't the
 * module's default, in the order the module lists them. Empty when every
 * input is at its default.
 */
export function inputsHcl(
  values: Readonly<Record<string, unknown>>,
  inputs: readonly InputDefault[],
): string {
  return inputs
    .filter((input) => Object.hasOwn(values, input.name) && !isDefault(input, values[input.name]))
    .map((input) => `  ${input.name} = ${hclValue(values[input.name], "  ")}`)
    .join("\n")
}
