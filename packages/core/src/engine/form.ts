/**
 * A form as the session holds it: a form block's, or a task's own. It starts
 * from the runbook's defaults, and `enter` puts in what a person or agent
 * sends, as if typed. A value is checked when the form is read, not when it
 * is entered: an invalid one stays in the form, with its error, until someone
 * changes it, as it would in the window.
 */
import { Schema } from "effect"
import type { OutputDecls } from "@runbooks/blocks-core/contract"
import { type Field, FieldValue, type FormSpec, type FormValues } from "@runbooks/blocks-core/form"
import { nearest } from "../document/nearest.ts"
import { hiddenVariables } from "../domain/boilerplate/showWhen.ts"
import { validateVariableValue } from "../domain/boilerplate/validators.ts"
import { type Held, hold, reveal, visible } from "./held.ts"
import type { FieldView, Origin } from "./protocol.ts"

interface Entry {
  readonly field: Field
  /** Absent while the field is empty. */
  readonly value: Held<FieldValue> | undefined
  /** An agent set or confirmed it, and no person has changed it since. */
  readonly reviewed: boolean
}

/** One entry per field, in the form's order. */
export type Form = ReadonlyArray<Entry>

/**
 * What a field holds: `value`, or nothing for a blank number or choice, as a
 * cleared control sends `""`. A text field keeps `""`, which is a value.
 */
function fill(field: Field, value: FieldValue | undefined): Held<FieldValue> | undefined {
  switch (field.type) {
    case "int":
    case "float":
    case "enum":
      if (value === "") return undefined
      break
    case "string":
    case "bool":
    case "list":
    case "map":
      break
  }
  return value === undefined ? undefined : hold(field.sensitive, value)
}

/** What a field starts with: its default, else what its control shows untouched (an unticked box). */
const startOf = (field: Field): FieldValue | undefined =>
  field.default ?? (field.type === "bool" ? false : undefined)

/**
 * What a task reads for an empty field: `""`, as the app's templates render
 * an optional field left empty, or an empty list or map.
 */
function emptyOf(field: Field): FieldValue {
  switch (field.type) {
    case "list":
      return []
    case "map":
      return {}
    case "bool":
      return false
    case "string":
    case "int":
    case "float":
    case "enum":
      return ""
  }
}

const sameValue = Schema.toEquivalence(Schema.UndefinedOr(FieldValue))

export const makeForm = (spec: FormSpec): Form =>
  spec.fields.map((field) => ({ field, value: fill(field, startOf(field)), reviewed: false }))

/** Why a value is not one the field's type holds. */
function typeError(field: Field, value: FieldValue): string | undefined {
  switch (field.type) {
    case "string":
      return typeof value === "string" ? undefined : "Expected text."
    case "int":
      return Number.isInteger(value) ? undefined : "Expected a whole number."
    case "float":
      return typeof value === "number" ? undefined : "Expected a number."
    case "bool":
      return typeof value === "boolean" ? undefined : "Expected true or false."
    case "enum": {
      const options = field.options ?? []
      if (typeof value === "string" && options.length === 0) return undefined
      return typeof value === "string" && options.includes(value)
        ? undefined
        : `Expected one of: ${options.join(", ")}.`
    }
    case "list":
      return Array.isArray(value) ? undefined : "Expected a list."
    case "map":
      return typeof value === "object" && !Array.isArray(value)
        ? undefined
        : "Expected a map of names to values."
  }
}

/**
 * The field's error for `value`: an empty field is the required check's to
 * judge. No message holds the value, so a sensitive one stays out of it.
 */
const fieldError = (field: Field, value: FieldValue | undefined): string | undefined =>
  (value === undefined ? undefined : typeError(field, value)) ??
  validateVariableValue(
    {
      name: field.name,
      type: field.type,
      required: field.required,
      validations: field.validations.map(({ kind, message, args }) => ({
        type: kind,
        ...(message === undefined ? {} : { message }),
        ...(args === undefined ? {} : { args }),
      })),
    },
    value,
  )

interface Checked extends Entry {
  /** Its `showWhen` holds, or it has none. A field it hides is not asked for, nor checked. */
  readonly asked: boolean
  readonly error: string | undefined
}

const revealed = (entry: Entry): FieldValue | undefined =>
  entry.value === undefined ? undefined : reveal(entry.value)

function check(form: Form): ReadonlyArray<Checked> {
  const fields = form.map((entry) => entry.field)
  const values = Object.fromEntries(form.map((entry) => [entry.field.name, revealed(entry)]))
  const conditional = hiddenVariables(fields, values, startOf)
  return form.map((entry) => {
    const asked = !conditional.has(entry.field.name)
    return { ...entry, asked, error: asked ? fieldError(entry.field, revealed(entry)) : undefined }
  })
}

/** A client is shown the field: it is asked for, and not `hidden`. */
const isShown = ({ asked, field }: Checked): boolean => asked && !field.hidden

/**
 * Puts `values` in the fields they name. A value an agent enters is reviewed;
 * one a person changes is not, since the agent has not seen it. A field
 * nobody may change, or one the form lacks, keeps its value.
 */
export function enter(
  form: Form,
  values: Readonly<Record<string, FieldValue>>,
  origin: Origin,
): { readonly form: Form; readonly rejected: Record<string, string> } {
  const sent = new Map(Object.entries(values))
  const settable = form.filter((entry) => !entry.field.hidden).map((entry) => entry.field)
  const rejected = Array.from(sent.keys()).flatMap((name): Array<[string, string]> => {
    const field = settable.find((candidate) => candidate.name === name)
    if (field === undefined) {
      const near = nearest(
        name,
        settable.map((candidate) => candidate.name),
      )
      const hint = near === undefined ? "" : ` Did you mean "${near}"?`
      return [[name, `The form has no field "${name}".${hint}`]]
    }
    return field.locked ? [[name, `"${name}" is read-only.`]] : []
  })
  return {
    form: form.map((entry) => {
      const sentValue = sent.get(entry.field.name)
      if (sentValue === undefined || entry.field.locked || entry.field.hidden) return entry
      const value = fill(entry.field, sentValue)
      const changed = !sameValue(revealed(entry), value === undefined ? undefined : reveal(value))
      return { field: entry.field, value, reviewed: reviewedAfter(entry, origin, changed) }
    }),
    rejected: Object.fromEntries(rejected),
  }
}

function reviewedAfter(entry: Entry, origin: Origin, changed: boolean): boolean {
  switch (origin) {
    case "agent":
      return true
    case "person":
      return entry.reviewed && !changed
  }
}

/** An agent accepts every field a client is shown, as it stands. */
export const confirm = (form: Form): Form =>
  check(form).map((checked) => ({
    field: checked.field,
    value: checked.value,
    reviewed: checked.reviewed || isShown(checked),
  }))

/** Each field's error, by name, in the form's order. */
export const fieldErrors = (form: Form): ReadonlyArray<readonly [string, string]> =>
  check(form).flatMap(({ field, error }) => (error === undefined ? [] : [[field.name, error]]))

/** The fields a client is shown that nobody has set or confirmed. A locked field has nothing to review. */
export const unreviewedOf = (form: Form): ReadonlyArray<string> =>
  check(form)
    .filter((checked) => isShown(checked) && !checked.reviewed && !checked.field.locked)
    .map(({ field }) => field.name)

/** The fields a client is shown, sensitive values hidden. */
export const fieldViews = (form: Form): ReadonlyArray<FieldView> =>
  check(form)
    .filter(isShown)
    .map(({ field, value, reviewed, error }) => ({
      name: field.name,
      type: field.type,
      description: field.description,
      required: field.required,
      sensitive: field.sensitive,
      ...(field.options === undefined ? {} : { options: field.options }),
      ...(value === undefined ? {} : { value: visible(value) }),
      ...(field.default === undefined || field.sensitive ? {} : { default: field.default }),
      readOnly: field.locked,
      ...(error === undefined ? {} : { error }),
      validations: field.validations,
      reviewed: reviewed || field.locked,
      unresolved: [],
    }))

/**
 * The values a block that reads the form gets, sensitive ones in clear. A
 * field its `showWhen` hides gives its default, not what was entered before
 * it was hidden.
 */
export const valuesOf = (form: Form): FormValues =>
  Object.fromEntries(
    check(form).map((checked) => [
      checked.field.name,
      (checked.asked ? revealed(checked) : startOf(checked.field)) ?? emptyOf(checked.field),
    ]),
  )

/** A value as a template prints it: a list or map as JSON. */
function text(value: FieldValue): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

/**
 * A submitted form's outputs: each declared output is the field of the same
 * name, as text, sensitive if either the declaration or the field is.
 */
export function outputsOf(
  form: Form,
  declared: OutputDecls<string>,
): ReadonlyMap<string, Held<string>> {
  const values = valuesOf(form)
  return new Map(
    form.flatMap(({ field }): Array<[string, Held<string>]> => {
      const decl = Object.hasOwn(declared, field.name) ? declared[field.name] : undefined
      const value = values[field.name]
      if (decl === undefined || value === undefined) return []
      return [[field.name, hold(decl.sensitive || field.sensitive, text(value))]]
    }),
  )
}
