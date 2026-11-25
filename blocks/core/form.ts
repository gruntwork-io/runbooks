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

/** A form value. Lists and maps nest. */
export type FieldValue =
  | string
  | number
  | boolean
  | ReadonlyArray<FieldValue>
  | { readonly [key: string]: FieldValue }

export const FieldValue: Schema.Codec<FieldValue> = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.suspend((): Schema.Codec<FieldValue> => FieldValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<FieldValue> => FieldValue),
  ),
])

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

export const Section = Schema.Struct({
  name: Schema.String,
  fields: Schema.Array(Schema.String),
})
export type Section = typeof Section.Type

export const FormSpec = Schema.Struct({
  fields: Schema.Array(Field),
  /** Field order by section. Fields in no section follow, in field order. */
  sections: Schema.Array(Section),
})
export type FormSpec = typeof FormSpec.Type

/** Validated form values, by field name. */
export type FormValues = { readonly [name: string]: FieldValue }
