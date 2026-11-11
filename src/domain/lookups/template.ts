/**
 * The templates in a lookup's or check's request, such as
 * `{{ .lookups.aws.identityStore.identityStoreId }}`. The only action is a
 * value: `{{ .inputs.name }}`, `{{ .auth.region }}`, `{{ .params.api }}`,
 * `{{ .lookups.<group>.<lookup>.<field> }}` or `{{ .query }}`. There are no
 * functions, pipes or conditions, so a template can't compute anything, and
 * anything else between the braces is a load error.
 */

/** Where a template reads a value from. */
export type Ref =
  | { readonly kind: "inputs"; readonly name: string }
  | { readonly kind: "auth"; readonly name: string }
  | { readonly kind: "params"; readonly name: string }
  | { readonly kind: "lookups"; readonly lookup: string; readonly field: string }
  | { readonly kind: "query" }

const TOKEN = /\{\{-?\s*(.*?)\s*-?\}\}/g
const NAME = "[A-Za-z_][\\w-]*"
const SIMPLE = new RegExp(`^\\.(inputs|auth|params)\\.(${NAME})$`)
const LOOKUP = new RegExp(`^\\.lookups\\.(${NAME})\\.(${NAME})\\.(${NAME})$`)

export interface Token {
  readonly start: number
  readonly end: number
  readonly ref: Ref
}

/** The tokens in `text`, in order. Throws with the bad action when one isn't a value. */
export function tokens(text: string): Token[] {
  const found: Token[] = []
  for (const match of text.matchAll(TOKEN)) {
    const action = match[1] ?? ""
    found.push({ start: match.index, end: match.index + match[0].length, ref: parseRef(action) })
  }
  const stray = text.replace(TOKEN, "")
  if (stray.includes("{{") || stray.includes("}}")) {
    throw new Error(`"${text}" has an unclosed {{ or a stray }}.`)
  }
  return found
}

function parseRef(action: string): Ref {
  if (action === ".query") return { kind: "query" }
  const simple = SIMPLE.exec(action)
  if (simple) {
    return { kind: simple[1] as "inputs" | "auth" | "params", name: simple[2] ?? "" }
  }
  const lookup = LOOKUP.exec(action)
  if (lookup)
    return { kind: "lookups", lookup: `${lookup[1]}.${lookup[2]}`, field: lookup[3] ?? "" }
  throw new Error(
    `{{ ${action} }} isn't a value a request can read. Use .inputs.<name>, .auth.<fact>, .params.<name>, .lookups.<group>.<lookup>.<field> or .query.`,
  )
}

/** The values a template can read. */
export interface TemplateValues {
  readonly inputs: Readonly<Record<string, unknown>>
  readonly auth: Readonly<Record<string, string>>
  readonly params: Readonly<Record<string, string>>
  /** Each chained lookup's one row, by `<group>.<lookup>`. */
  readonly lookups: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly query: string
}

/** A value as text: a string as it is, anything else as JSON, and nothing for a missing value. */
export function valueText(value: unknown): string {
  if (value === undefined || value === null) return ""
  return typeof value === "string" ? value : JSON.stringify(value)
}

export function readRef(ref: Ref, values: TemplateValues): string {
  switch (ref.kind) {
    case "inputs":
      return valueText(values.inputs[ref.name])
    case "auth":
      return values.auth[ref.name] ?? ""
    case "params":
      return values.params[ref.name] ?? ""
    case "lookups":
      return valueText(values.lookups[ref.lookup]?.[ref.field])
    case "query":
      return values.query
  }
}

/** Render `text`, passing each value through `encode` before it goes in. */
export function render(
  text: string,
  values: TemplateValues,
  encode: (value: string, token: Token) => string = (value) => value,
): string {
  let out = ""
  let last = 0
  for (const token of tokens(text)) {
    out += text.slice(last, token.start) + encode(readRef(token.ref, values), token)
    last = token.end
  }
  return out + text.slice(last)
}
