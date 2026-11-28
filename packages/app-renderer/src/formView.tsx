/**
 * `FormView`: a form's fields as the engine sends them (`BlockView.fields`),
 * each with a control for its type, its label, whether it is required, its
 * description and its error. It draws the fields it is given, in their order,
 * and decides nothing the engine decides: which fields show, which are
 * read-only, which value is valid.
 *
 * What the person enters goes to the engine as they enter it (`enter`). The
 * field shows what they entered until every value entered in it has been
 * answered and the engine's view of the field shows it too, so an answer or
 * a view that arrives while they type never takes a keystroke back or moves
 * the cursor. A sensitive field's value never comes back (`Hidden`), so its
 * box holds only what the person typed in it.
 *
 * Field types are a closed set: the switch over them names every one.
 */
import { Effect, Equal } from "effect"
import { useId, useState } from "react"
import type { FieldView } from "@runbooks/core/protocol"
import { fieldLabel } from "./label.ts"
import { Markdown } from "./markdown.tsx"

/** A form value: what a field holds, and what `SetValues` takes. */
export type FieldValue = NonNullable<FieldView["default"]>
/** A value as a box shows it: nothing for none, a list or map as JSON. */
function textOf(value: FieldValue | undefined): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

/** What a field's control holds while the engine holds nothing in it. */
function blankOf(type: FieldView["type"]): FieldValue {
  switch (type) {
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
    default: {
      const unhandled: never = type
      throw new Error(`The form has no blank value for the type ${String(unhandled)}.`)
    }
  }
}

/** The engine's value of `field`, when it shows one. */
const shownBy = (field: FieldView): FieldValue | undefined =>
  field.value?._tag === "Shown" ? field.value.value : undefined

interface Entry {
  /** What the person entered in each field, shown in place of the engine's value. */
  readonly drafts: ReadonlyMap<string, FieldValue>
  /** How many of the values entered in each field the engine has not answered. */
  readonly waiting: ReadonlyMap<string, number>
}

const NOTHING_ENTERED: Entry = { drafts: new Map(), waiting: new Map() }

function counted(waiting: Entry["waiting"], name: string, by: number): Entry["waiting"] {
  const next = new Map(waiting)
  const count = (waiting.get(name) ?? 0) + by
  if (count === 0) next.delete(name)
  else next.set(name, count)
  return next
}

/**
 * `entry` without the drafts the engine has caught up with: those whose
 * values are all answered, of a field the form no longer shows, one that is
 * sensitive or read-only, or one whose view shows the draft. The engine's views come in the
 * order it made them, so once nothing is waiting, a view that shows the
 * draft is not one from before it.
 */
function settled(entry: Entry, fields: ReadonlyArray<FieldView>): Entry {
  const drafts = new Map(entry.drafts)
  for (const [name, draft] of entry.drafts) {
    if (entry.waiting.has(name)) continue
    const field = fields.find((shown) => shown.name === name)
    if (
      field === undefined ||
      field.sensitive ||
      field.readOnly ||
      Equal.equals(shownBy(field) ?? blankOf(field.type), draft)
    )
      drafts.delete(name)
  }
  return drafts.size === entry.drafts.size ? entry : { ...entry, drafts }
}

export function FormView({
  fields,
  enter,
  runbook,
  session,
}: {
  readonly fields: ReadonlyArray<FieldView>
  /** Sends values the person entered, as `SetValues` takes them. It ends once the engine answered. */
  readonly enter: (values: Readonly<Record<string, FieldValue>>) => Effect.Effect<void>
  /** The runbook file and the session that has it open, which a description is walked with. */
  readonly runbook: string
  readonly session: string
}) {
  const [entry, setEntry] = useState(NOTHING_ENTERED)
  const current = settled(entry, fields)
  if (current !== entry) setEntry(current)
  const change = (name: string, value: FieldValue) => {
    setEntry((before) => ({
      drafts: new Map(before.drafts).set(name, value),
      waiting: counted(before.waiting, name, 1),
    }))
    const answered = Effect.sync(() =>
      setEntry((before) => ({ ...before, waiting: counted(before.waiting, name, -1) })),
    )
    Effect.runFork(Effect.ensuring(enter({ [name]: value }), answered))
  }
  return (
    <div className="form">
      {fields.map((field) => (
        <FormField
          key={field.name}
          field={field}
          value={current.drafts.has(field.name) ? current.drafts.get(field.name) : shownBy(field)}
          onChange={(value) => change(field.name, value)}
          runbook={runbook}
          session={session}
        />
      ))}
    </div>
  )
}

interface ControlProps {
  readonly id: string
  /** The id of the field's label, for a control that is a group. */
  readonly labelId: string
  readonly field: FieldView
  readonly value: FieldValue | undefined
  readonly onChange: (value: FieldValue) => void
}

/** One field: its label, then its control (a box's after it), its description and its error. */
function FormField({
  field,
  value,
  onChange,
  runbook,
  session,
}: Omit<ControlProps, "id" | "labelId"> & { readonly runbook: string; readonly session: string }) {
  const id = useId()
  const labelId = `${id}-label`
  const label = (
    <label htmlFor={id} id={labelId} className="form-label">
      {fieldLabel(field.name)}
      {field.required && !field.readOnly ? <span className="form-required">*</span> : null}
      {field.readOnly ? (
        <>
          {" "}
          <span className="form-read-only">(read-only)</span>
        </>
      ) : null}
    </label>
  )
  const control = (
    <Control id={id} labelId={labelId} field={field} value={value} onChange={onChange} />
  )
  const box = field.type === "bool" && !field.sensitive
  return (
    <div className="form-field" data-testid={`field-${field.name}`}>
      {box ? (
        <div className="form-check">
          {control}
          {label}
        </div>
      ) : (
        <>
          {label}
          {control}
        </>
      )}
      {(field.description.children ?? []).length === 0 ? null : (
        <div className="form-description">
          <Markdown
            document={{ tree: field.description, blocks: [] }}
            runbook={runbook}
            session={session}
          />
        </div>
      )}
      {field.error === undefined ? null : <p className="form-error">{field.error}</p>}
    </div>
  )
}

function Control(props: ControlProps) {
  const { id, field, value, onChange } = props
  if (field.sensitive) return <SecretControl {...props} />
  const disabled = field.readOnly
  switch (field.type) {
    case "string":
      return (
        <input
          type="text"
          id={id}
          value={textOf(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case "int":
    case "float":
      return (
        <NumberBox
          id={id}
          value={typeof value === "number" ? value : ""}
          parse={parseFloat}
          step={field.type === "float" ? "any" : undefined}
          disabled={disabled}
          onChange={onChange}
        />
      )
    case "bool":
      return (
        <input
          type="checkbox"
          id={id}
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      )
    case "enum":
      return <EnumControl {...props} />
    case "list":
    case "map":
      return <p className="form-hidden">The window can't enter a {field.type} yet.</p>
    default: {
      const unhandled: never = field.type
      throw new Error(`The form has no control for the type ${String(unhandled)}.`)
    }
  }
}

/** A number as typed: nothing for an empty or unfinished one ("1.", "-"), as the box reports it. */
const numberIn = (text: string, parse: (text: string) => number): number | "" => {
  const number = text === "" ? Number.NaN : parse(text)
  return Number.isNaN(number) ? "" : number
}

/**
 * A number box. It shows the text the person typed while that is the value
 * it holds, so "1.50" stays as typed, not "1.5", with the cursor where it was.
 */
function NumberBox({
  id,
  value,
  parse,
  step,
  disabled,
  onChange,
}: {
  readonly id: string
  readonly value: number | ""
  readonly parse: (text: string) => number
  readonly step?: "any" | undefined
  readonly disabled: boolean
  readonly onChange: (value: number | "") => void
}) {
  const [typed, setTyped] = useState<string>()
  const shown = typed !== undefined && numberIn(typed, parse) === value ? typed : String(value)
  return (
    <input
      type="number"
      id={id}
      value={shown}
      step={step}
      disabled={disabled}
      onChange={(event) => {
        setTyped(event.target.value)
        onChange(numberIn(event.target.value, parse))
      }}
    />
  )
}

/**
 * A sensitive field: a password box holding what the person typed, never the
 * engine's value. It says when the engine holds one. A number is sent as
 * one once it reads as one. A sensitive true/false, list or map has no box.
 */
function SecretControl({ id, field, onChange }: ControlProps) {
  const [typed, setTyped] = useState("")
  const held = field.value?._tag === "Hidden"
  switch (field.type) {
    case "string":
    case "enum":
    case "int":
    case "float":
      return (
        <input
          type="password"
          id={id}
          value={typed}
          placeholder={held ? "Hidden: it is sensitive." : undefined}
          autoComplete="off"
          disabled={field.readOnly}
          onChange={(event) => {
            const text = event.target.value
            setTyped(text)
            const number = Number(text)
            const numeric = field.type === "int" || field.type === "float"
            onChange(numeric && text.trim() !== "" && Number.isFinite(number) ? number : text)
          }}
        />
      )
    case "bool":
    case "list":
    case "map":
      return (
        <p className="form-hidden">
          {held ? "Hidden: it is sensitive." : "Empty."} The window can't enter a sensitive{" "}
          {field.type} yet.
        </p>
      )
    default: {
      const unhandled: never = field.type
      throw new Error(`The form has no sensitive control for the type ${String(unhandled)}.`)
    }
  }
}

/**
 * A choice of the field's options, each as its label. With no value, or one
 * not among them, it says so in a disabled first option, so the box never
 * shows a choice the field doesn't hold.
 */
function EnumControl({ id, field, value, onChange }: ControlProps) {
  const options = field.options ?? []
  const current = textOf(value)
  return (
    <select
      id={id}
      value={current}
      disabled={field.readOnly}
      onChange={(event) => onChange(event.target.value)}
    >
      {current === "" && (value === undefined || !options.includes("")) ? (
        <option value="" disabled>
          Select…
        </option>
      ) : null}
      {current !== "" && !options.includes(current) ? (
        <option value={current} disabled>
          {current}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option} value={option}>
          {field.optionLabels?.[option] ?? option}
        </option>
      ))}
    </select>
  )
}
