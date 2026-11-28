/**
 * A form as the session holds it: a form block's, or a task's own. It starts
 * from the runbook's defaults, and `enter` puts in what a person or agent
 * sends, as if typed. A value is checked when the form is read, not when it
 * is entered: an invalid one stays in the form, with its error, until someone
 * changes it, as it would in the window.
 */
import { Redacted, Result, Schema } from "effect"
import type { FormOutputDecls, TaskValues } from "@runbooks/blocks-core/contract"
import {
  type Field,
  FieldValue,
  type FormSpec,
  type Section,
  templateText,
} from "@runbooks/blocks-core/form"
import type { TreeNode } from "../document/document.ts"
import { markdownTree } from "../document/markdown.ts"
import { MAX_NESTING } from "../document/mdx.ts"
import { nearest } from "../document/nearest.ts"
import { valueAt } from "../document/valueTemplate.ts"
import { hiddenVariables } from "../domain/boilerplate/showWhen.ts"
import { isTemplateString } from "../domain/boilerplate/templateString.ts"
import { validateVariableValue } from "../domain/boilerplate/validators.ts"
import { type Held, hold, reveal, visible } from "./held.ts"
import type { FieldView, Origin } from "./protocol.ts"

interface Entry {
  readonly field: Field
  /** The field's description as the window walks it, parsed once, when the form is made. */
  readonly description: TreeNode
  /** The section it is in (`Field.section`), as the form's spec lists it. */
  readonly section: Section | undefined
  /** Absent while the field is empty. */
  readonly value: Held<FieldValue> | undefined
  /** An agent set or confirmed it, and no person has changed it since. */
  readonly reviewed: boolean
}

/** One entry per field, in the order the window draws them (`FormSpec.sections`). */
export type Form = ReadonlyArray<Entry>

/** A field nobody may change: a locked one, or a hidden one, which is locked too. */
const isLocked = (field: Field): boolean => field.locked || field.hidden

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

/**
 * `spec`'s sections in the order the window draws them: as `spec.sections`
 * lists them, each once, where it is first; then any a field names that it
 * does not list, in the order of their first field, unfolded.
 */
function sectionsIn(spec: FormSpec): ReadonlyArray<Section> {
  const listed = new Map<string, Section>()
  for (const section of spec.sections)
    if (!listed.has(section.name)) listed.set(section.name, section)
  for (const { section: name } of spec.fields)
    if (name !== undefined && !listed.has(name)) listed.set(name, { name, collapsed: false })
  return [...listed.values()]
}

/** Whether a default reads other values: a `{{ }}` in it, its items, or its keys or values. */
function readsValues(value: FieldValue): boolean {
  if (typeof value === "string") return isTemplateString(value)
  if (typeof value !== "object") return false
  return Array.isArray(value)
    ? value.some(readsValues)
    : Object.entries(value).some(([key, inner]) => isTemplateString(key) || readsValues(inner))
}

/**
 * Why the form cannot hold `field` as written: a message for each reason.
 * None quotes its default, which may be a secret.
 */
function problemsOf(field: Field, description: TreeNode | undefined): ReadonlyArray<string> {
  const named = `the field "${field.name}"`
  return [
    ...(description === undefined
      ? [
          `The description of ${named} is nested more than ${MAX_NESTING} levels deep. A description may nest its quotes and lists, and the parts inside them, at most ${MAX_NESTING} levels deep.`,
        ]
      : []),
    // Linked values and options from outputs land in a row of their own, before Template.
    ...(field.default !== undefined && readsValues(field.default)
      ? [
          `The default of ${named} reads other values with {{ }}, which is not built yet: give it a plain value.`,
        ]
      : []),
    ...(field.optionsFrom === undefined
      ? []
      : [
          `The options of ${named} come from the output "${field.optionsFrom.output}" of "${field.optionsFrom.block}", which is not built yet: list them in its options.`,
        ]),
  ]
}

/**
 * A form for `spec`, from its defaults, none of them reviewed, its fields
 * in the order the window draws them, or why it cannot be made: for each
 * field in `spec`'s order, a description nested too deep for the window to
 * draw (`markdownTree`), or what is not built yet.
 */
export function makeForm(spec: FormSpec): Result.Result<Form, ReadonlyArray<string>> {
  const parsed = spec.fields.map((field) => ({
    field,
    description: markdownTree(field.description),
  }))
  const problems = parsed.flatMap(({ field, description }) => problemsOf(field, description))
  if (problems.length > 0) return Result.fail(problems)
  const sections = sectionsIn(spec)
  const entries = parsed.flatMap(({ field, description }): ReadonlyArray<Entry> =>
    description === undefined
      ? []
      : [
          {
            field,
            description,
            section: sections.find(({ name }) => name === field.section),
            value: fill(field, startOf(field)),
            reviewed: false,
          },
        ],
  )
  // Fields in no section first; the sort keeps field order within each.
  const rank = ({ section }: Entry) => (section === undefined ? -1 : sections.indexOf(section))
  return Result.succeed([...entries].sort((a, b) => rank(a) - rank(b)))
}

/**
 * The sections the form's fields are in, in order, each once: what the
 * window folds them in. A section no field is in is left out.
 */
export function sectionsOf(form: Form): ReadonlyArray<Section> {
  const found = new Map<string, Section>()
  for (const { section } of form)
    if (section !== undefined && !found.has(section.name)) found.set(section.name, section)
  return [...found.values()]
}

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

/**
 * A client is shown the field: it is asked for, and not `hidden`, or hidden
 * with an error, which it shows locked, so a block never waits on a field
 * nobody can see.
 */
const isShown = ({ asked, error, field }: Checked): boolean =>
  asked && (!field.hidden || error !== undefined)

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
  const shown = new Set(
    check(form)
      .filter(isShown)
      .map(({ field }) => field.name),
  )
  const settable = form
    .filter((entry) => !entry.field.hidden || shown.has(entry.field.name))
    .map((entry) => entry.field)
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
    return isLocked(field) ? [[name, `"${name}" is read-only.`]] : []
  })
  return {
    form: form.map((entry) => {
      const sentValue = sent.get(entry.field.name)
      if (sentValue === undefined || isLocked(entry.field)) return entry
      const value = fill(entry.field, sentValue)
      const changed = !sameValue(revealed(entry), value === undefined ? undefined : reveal(value))
      return { ...entry, value, reviewed: reviewedAfter(entry, origin, changed) }
    }),
    rejected: Object.fromEntries(rejected),
  }
}

/**
 * The values a person or agent may change, by field name, as a saved
 * session keeps them: null for a field left empty. A locked or hidden field
 * holds the runbook's own, so it is not kept.
 */
export const savedValuesOf = (form: Form): Record<string, FieldValue | null> =>
  Object.fromEntries(
    form
      .filter(({ field }) => !field.locked && !field.hidden)
      .map((entry) => [entry.field.name, revealed(entry) ?? null]),
  )

/**
 * The form with a resumed session's values put back in the fields a person
 * or agent may change, none of them reviewed: an agent of the session
 * before has not seen them in this one. A value for a field the form no
 * longer has is dropped; one the field no longer takes stays, with its
 * error, as one typed would.
 */
export const restoreValues = (
  form: Form,
  saved: Readonly<Record<string, FieldValue | null>>,
): Form =>
  form.map((entry) => {
    const { field } = entry
    const value = Object.hasOwn(saved, field.name) ? saved[field.name] : undefined
    if (value === undefined || field.locked || field.hidden) return entry
    return { ...entry, value: value === null ? undefined : fill(field, value), reviewed: false }
  })

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
    description: checked.description,
    section: checked.section,
    value: checked.value,
    reviewed: checked.reviewed || isShown(checked),
  }))

/** Each field's error, by name, in the form's order. */
export const fieldErrors = (form: Form): ReadonlyArray<readonly [string, string]> =>
  check(form).flatMap(({ field, error }) => (error === undefined ? [] : [[field.name, error]]))

/**
 * What a block that reads `{{ .inputs.<input> }}` finds in the form, by the
 * field the input names (the part before its first `.`): `absent` for a
 * form without that field; `empty` while the field is asked for, has no
 * error, and gives a task nothing at `input`, so the block waits for a
 * value (#489); otherwise `ready`. Nothing is `""`, or no entry at a map's
 * key. A default, `""` included, lets the field itself stay `""`, as
 * today's app has it, but not a key in it. A field with an error holds the
 * block already, as the form's own check (`fieldErrors`), and a field its
 * `showWhen` hides is not asked for: it gives its default.
 */
export function inputIn(form: Form, input: string): "absent" | "empty" | "ready" {
  const [name, ...keys] = input.split(".")
  const checked = check(form).find(({ field }) => field.name === name)
  if (checked === undefined) return "absent"
  const { asked, error, field } = checked
  if (!asked || error !== undefined) return "ready"
  const value = valueAt(revealed(checked) ?? emptyOf(field), keys)
  const mayBeEmpty = keys.length === 0 && field.default !== undefined
  return value === undefined || (value === "" && !mayBeEmpty) ? "empty" : "ready"
}

/** The fields a client is shown that nobody has set or confirmed. A locked field has nothing to review. */
export const unreviewedOf = (form: Form): ReadonlyArray<string> =>
  check(form)
    .filter((checked) => isShown(checked) && !checked.reviewed && !isLocked(checked.field))
    .map(({ field }) => field.name)

/** The fields a client is shown, sensitive values hidden. */
export const fieldViews = (form: Form): ReadonlyArray<FieldView> =>
  check(form)
    .filter(isShown)
    .map(({ field, description, value, reviewed, error }) => ({
      name: field.name,
      type: field.type,
      description,
      required: field.required,
      sensitive: field.sensitive,
      ...(field.options === undefined ? {} : { options: field.options }),
      ...(field.optionLabels === undefined ? {} : { optionLabels: field.optionLabels }),
      ...(field.section === undefined ? {} : { section: field.section }),
      ...(field.schema === undefined ? {} : { schema: field.schema }),
      ...(field.schemaInstanceLabel === undefined
        ? {}
        : { schemaInstanceLabel: field.schemaInstanceLabel }),
      ...(value === undefined ? {} : { value: visible(value) }),
      ...(field.default === undefined || field.sensitive ? {} : { default: field.default }),
      readOnly: isLocked(field),
      ...(error === undefined ? {} : { error }),
      validations: field.validations,
      reviewed: reviewed || isLocked(field),
      unresolved: [],
    }))

/**
 * What a block that reads the form gets of a field: what it holds. A field
 * its `showWhen` hides gives its default, not what was entered before it was
 * hidden. A field with an error gives what an empty one does, so the form
 * publishes only valid values: a reader's run waits for a form without
 * errors anyway, so only a reader's instruction ever meets one.
 */
const givenOf = (checked: Checked): FieldValue =>
  (!checked.asked
    ? startOf(checked.field)
    : checked.error === undefined
      ? revealed(checked)
      : undefined) ?? emptyOf(checked.field)

/** The values a block that reads the form gets (`givenOf`), each redacted, a sensitive one or not. */
export const valuesOf = (form: Form): TaskValues =>
  new Map(check(form).map((checked) => [checked.field.name, Redacted.make(givenOf(checked))]))

/**
 * A submitted form's outputs: each declared output is the value of the field
 * it names, as text, as `valuesOf` gives it to a task, and sensitive when the
 * field is. The session refuses a form whose output names a field it does not
 * have when it opens, so each declared output is here.
 */
export function outputsOf(
  form: Form,
  declared: FormOutputDecls,
): ReadonlyMap<string, Held<string>> {
  const values = valuesOf(form)
  return new Map(
    Object.entries(declared).flatMap(([output, { field: name }]): Array<[string, Held<string>]> => {
      const entry = form.find(({ field }) => field.name === name)
      const value = values.get(name)
      if (entry === undefined || value === undefined) return []
      return [[output, hold(entry.field.sensitive, templateText(Redacted.value(value)))]]
    }),
  )
}
