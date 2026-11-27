/**
 * The form a block shows: the fields of an Inputs block, a Template's
 * variables, or a task's own parameters. It is data, so every client draws
 * the same form and the engine validates it once.
 */
import { Schema } from "effect"

/** A field's value type, as boilerplate.yml spells it. */
export const FieldType = Schema.Literals(["string", "int", "float", "bool", "list", "map", "enum"])
export type FieldType = typeof FieldType.Type

export const ValidationKind = Schema.Literals([
  "required",
  "url",
  "email",
  "alpha",
  "digit",
  "alphanumeric",
  "countrycode2",
  "semver",
  "length",
  "regex",
  "custom",
])
export type ValidationKind = typeof ValidationKind.Type

export const Validation = Schema.Struct({
  kind: ValidationKind,
  message: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})
export type Validation = typeof Validation.Type

/** A form value. Lists and maps nest, at most `MAX_VALUE_DEPTH` levels deep. */
export type FieldValue =
  | string
  | number
  | boolean
  | ReadonlyArray<FieldValue>
  | { readonly [key: string]: FieldValue }

/**
 * The most lists and maps a form value may nest, one inside another: `"x"`
 * nests none, `["x"]` one. A form's own values nest three at most (a map
 * of entries, each a map of values), so this leaves room for any value an
 * author or agent means, and refuses one built to exhaust a reader: the
 * value's decode recurses, and overflows the stack at about 10,000 levels.
 */
export const MAX_VALUE_DEPTH = 32

/**
 * Whether `value` nests more lists or maps than `MAX_VALUE_DEPTH`. It keeps
 * its own stack and stops past the bound, so no value is too deep for it,
 * one that holds itself included.
 */
function nestsTooDeep(value: unknown): boolean {
  const pending: Array<readonly [unknown, number]> = [[value, 0]]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [part, outside] = next
    if (typeof part !== "object" || part === null) continue
    if (outside === MAX_VALUE_DEPTH) return true
    for (const inside of Object.values(part)) pending.push([inside, outside + 1])
  }
  return false
}

/** A value's shape, checked part by part. Only `FieldValue` uses it, once it has checked the depth. */
const Shape: Schema.Codec<FieldValue> = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.suspend((): Schema.Codec<FieldValue> => Shape)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<FieldValue> => Shape),
  ),
])

/**
 * A form value from anywhere: a default in YAML or a prop, `SetValues`, a
 * saved session, a test's inputs. Its depth is checked first, by a walk,
 * since the shape's decode recurses: a value nested too deep is a schema
 * error at its path, never a stack overflow. Only then is its shape
 * checked. Neither error quotes the value, which may be a secret.
 */
export const FieldValue: Schema.Codec<FieldValue> = Schema.declare(
  // The walk checks only the depth; `Shape` checks the rest.
  (value: unknown): value is FieldValue => !nestsTooDeep(value),
  { expected: `a value nested at most ${MAX_VALUE_DEPTH} levels deep` },
).pipe(Schema.decodeTo(Shape))

/** A field's choices come from another block's output, read when the form is drawn. */
export const OptionsSource = Schema.Struct({
  block: Schema.String,
  output: Schema.String,
})
export type OptionsSource = typeof OptionsSource.Type

export const Field = Schema.Struct({
  name: Schema.NonEmptyString,
  type: FieldType,
  description: Schema.String,
  default: Schema.optionalKey(FieldValue),
  required: Schema.Boolean,
  /** An enum's choices, or a list's suggested items. */
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The text each option is shown as, by value, where it differs from the value. */
  optionLabels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionsFrom: Schema.optionalKey(OptionsSource),
  validations: Schema.Array(Validation),
  /** The value is a secret: never logged, never sent to the window in clear. */
  sensitive: Schema.Boolean,
  /** A structured map's entry schema: field name to type. */
  schema: Schema.optionalKey(Schema.Record(Schema.String, FieldType)),
  schemaInstanceLabel: Schema.optionalKey(Schema.String),
  section: Schema.optionalKey(Schema.String),
  /** Shown, but nobody can change it. */
  locked: Schema.Boolean,
  /** Not shown. A hidden field is also locked. */
  hidden: Schema.Boolean,
  /** Shown only while each named field holds one of the listed values. */
  showWhen: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
})
export type Field = typeof Field.Type

/** A section a form's fields name (`Field.section`), which lists none of them itself. */
export const Section = Schema.Struct({
  name: Schema.String,
  /** The section starts folded. A section holding a field with an error opens. */
  collapsed: Schema.Boolean,
})
export type Section = typeof Section.Type

export const FormSpec = Schema.Struct({
  fields: Schema.Array(Field),
  /**
   * The sections, in the order the window draws them. Fields in no section
   * come first, in field order; then each section's, in field order. A
   * section a field names that this does not list follows those it lists,
   * in the order of its first field, unfolded; a name listed twice counts
   * once, where it is first.
   */
  sections: Schema.Array(Section),
})
export type FormSpec = typeof FormSpec.Type

/** A value as a template prints it: a list or map as JSON. */
export function templateText(value: FieldValue): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}
