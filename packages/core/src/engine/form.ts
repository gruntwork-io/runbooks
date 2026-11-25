/**
 * A form as the session holds it: a form block's, or a task's own. It starts
 * from the runbook's defaults, and `enter` puts in what a person or agent
 * sends, as if typed. A value is checked when the form is read, not when it
 * is entered: an invalid one stays in the form, with its error, until someone
 * changes it, as it would in the window.
 */
import type { Field, FieldValue, FormSpec, FormValues } from "@runbooks/blocks-core/form"
import { nearest } from "../document/nearest.ts"
import { hiddenVariables } from "../domain/boilerplate/showWhen.ts"
import { validateVariableValue } from "../domain/boilerplate/validators.ts"
import { type Held, hold, reveal, visible } from "./held.ts"
import type { FieldView } from "./protocol.ts"

interface Entry {
  readonly field: Field
  readonly value: Held<FieldValue>
  /** A person or agent set or confirmed it. */
  readonly reviewed: boolean
}

/** One entry per field, in the form's order. */
export type Form = ReadonlyArray<Entry>

/**
 * What a field holds while it has no value: what its control shows empty. A
 * number field left empty holds `""`, as a cleared input does.
 */
function emptyValue(field: Field): FieldValue {
  switch (field.type) {
    case "bool":
      return false
    case "list":
      return []
    case "map":
      return {}
    case "string":
    case "int":
    case "float":
    case "enum":
      return ""
  }
}

const defaultOf = (field: Field): FieldValue => field.default ?? emptyValue(field)

export const makeForm = (spec: FormSpec): Form =>
  spec.fields.map((field) => ({
    field,
    value: hold(field.sensitive, defaultOf(field)),
    reviewed: false,
  }))

/** Why a value is not one the field's type holds. A blank value is the required check's to judge. */
function typeError(field: Field, value: FieldValue): string | undefined {
  switch (field.type) {
    case "string":
      return typeof value === "string" ? undefined : "Expected text."
    case "int":
      return value === "" || Number.isInteger(value) ? undefined : "Expected a whole number."
    case "float":
      return value === "" || typeof value === "number" ? undefined : "Expected a number."
    case "bool":
      return typeof value === "boolean" ? undefined : "Expected true or false."
    case "enum": {
      const options = field.options ?? []
      if (value === "" || (typeof value === "string" && options.length === 0)) return undefined
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

/** The field's error for `value`. No message holds the value, so a sensitive one stays out of it. */
const fieldError = (field: Field, value: FieldValue): string | undefined =>
  typeError(field, value) ??
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

function check(form: Form): ReadonlyArray<Checked> {
  const fields = form.map((entry) => entry.field)
  const values = Object.fromEntries(form.map((entry) => [entry.field.name, reveal(entry.value)]))
  const conditional = hiddenVariables(fields, values, defaultOf)
  return form.map((entry) => {
    const asked = !conditional.has(entry.field.name)
    return {
      ...entry,
      asked,
      error: asked ? fieldError(entry.field, reveal(entry.value)) : undefined,
    }
  })
}

/** A client is shown the field: it is asked for, and not `hidden`. */
const isShown = ({ asked, field }: Checked): boolean => asked && !field.hidden

/** Puts `values` in the fields they name, each counted as reviewed. A field nobody may change, or one the form lacks, keeps its value. */
export function enter(
  form: Form,
  values: Readonly<Record<string, FieldValue>>,
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
      const value = sent.get(entry.field.name)
      if (value === undefined || entry.field.locked || entry.field.hidden) return entry
      return { field: entry.field, value: hold(entry.field.sensitive, value), reviewed: true }
    }),
    rejected: Object.fromEntries(rejected),
  }
}

/** Counts every field a client is shown as reviewed, as a person does by reading the form and moving on. */
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
      value: visible(value),
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
    check(form).map(({ field, value, asked }) => [
      field.name,
      asked ? reveal(value) : defaultOf(field),
    ]),
  )
