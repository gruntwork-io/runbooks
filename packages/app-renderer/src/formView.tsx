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
 * Fields are drawn in runs of one section each, as the engine orders them
 * (`BlockView.sections`): a section that starts folded (`collapsed`) has a
 * heading that opens and closes it. A field the person can change back to
 * its default has a Reset that sends the default.
 *
 * Field types are a closed set: the switch over them names every one.
 */
import { Effect, Equal } from "effect"
import { type ReactNode, useId, useState } from "react"
import type { BlockView, FieldView } from "@runbooks/core/protocol"
import { fieldLabel } from "./label.ts"
import { Markdown } from "./markdown.tsx"

/** A form value: what a field holds, and what `SetValues` takes. */
export type FieldValue = NonNullable<FieldView["default"]>
type Entries = { readonly [key: string]: FieldValue }

const isList = (value: FieldValue | undefined): value is ReadonlyArray<FieldValue> =>
  Array.isArray(value)
const isEntries = (value: FieldValue | undefined): value is Entries =>
  typeof value === "object" && !Array.isArray(value)
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

type Section = NonNullable<BlockView["sections"]>[number]

/** `fields` in runs of one section each, in the order given: a field in no section is in none. */
function runsOf(
  fields: ReadonlyArray<FieldView>,
): ReadonlyArray<{ readonly section: string | undefined; readonly fields: FieldView[] }> {
  const runs: Array<{ readonly section: string | undefined; readonly fields: FieldView[] }> = []
  for (const field of fields) {
    const last = runs.at(-1)
    if (last !== undefined && last.section === field.section) last.fields.push(field)
    else runs.push({ section: field.section, fields: [field] })
  }
  return runs
}

/** Whether `field` holds other than its default, so a Reset can put the default back. */
const resettable = (
  field: FieldView,
  value: FieldValue | undefined,
): field is FieldView & { readonly default: FieldValue } =>
  field.default !== undefined &&
  !field.readOnly &&
  !field.sensitive &&
  !Equal.equals(value ?? blankOf(field.type), field.default)

export function FormView({
  fields,
  sections,
  enter,
  runbook,
  session,
}: {
  readonly fields: ReadonlyArray<FieldView>
  readonly sections: ReadonlyArray<Section>
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
  const drawn = (field: FieldView) => {
    const value = current.drafts.has(field.name) ? current.drafts.get(field.name) : shownBy(field)
    return (
      <FormField
        key={field.name}
        field={field}
        value={value}
        onChange={(next) => change(field.name, next)}
        onReset={resettable(field, value) ? () => change(field.name, field.default) : undefined}
        runbook={runbook}
        session={session}
      />
    )
  }
  return (
    <div className="form">
      {runsOf(fields).map(({ section, fields: inRun }, index) =>
        section === undefined ? (
          inRun.map(drawn)
        ) : (
          <FormSection
            key={`${index}-${section}`}
            name={section}
            folds={sections.find(({ name }) => name === section)?.collapsed === true}
            erred={inRun.some((field) => field.error !== undefined)}
          >
            {inRun.map(drawn)}
          </FormSection>
        ),
      )}
    </div>
  )
}

/**
 * A section's heading, then its fields. One that starts folded opens and
 * closes from its heading, and says, while folded, when a field in it has
 * an error.
 */
function FormSection({
  name,
  folds,
  erred,
  children,
}: {
  readonly name: string
  readonly folds: boolean
  readonly erred: boolean
  readonly children: ReactNode
}) {
  const [open, setOpen] = useState(!folds)
  return (
    <div className="form-section">
      <h3 className="form-section-name">
        {folds ? (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            {name}
          </button>
        ) : (
          name
        )}
        {folds && !open && erred ? (
          <span className="form-section-error"> A field in it has an error.</span>
        ) : null}
      </h3>
      {open ? children : null}
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

/** One field: its label, then its control (a box's after it), its Reset, its description and its error. */
function FormField({
  field,
  value,
  onChange,
  onReset,
  runbook,
  session,
}: Omit<ControlProps, "id" | "labelId"> & {
  /** Puts the field's default back, when it holds another value the person can change. */
  readonly onReset: (() => void) | undefined
  readonly runbook: string
  readonly session: string
}) {
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
      {onReset === undefined ? null : (
        <button
          type="button"
          className="form-reset"
          aria-label={`Reset ${fieldLabel(field.name)} to its default`}
          onClick={onReset}
        >
          Reset
        </button>
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
      if ((field.options ?? []).length > 0) return <ChoicesControl {...props} />
      return Object.keys(field.schema ?? {}).length > 0 ? (
        <TupleControl {...props} />
      ) : (
        <ListControl {...props} />
      )
    case "map":
      return Object.keys(field.schema ?? {}).length > 0 ? (
        <EntriesControl {...props} />
      ) : (
        <MapControl {...props} />
      )
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
 * A number box. It shows the text the person typed while that text reads as
 * the value it holds, so "1.50" stays as typed, not "1.5", with the cursor
 * where it was, and "1.5" in a box that holds 1 shows as "1".
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
  const shown = typed !== undefined && numberIn(typed, Number) === value ? typed : String(value)
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

/**
 * A list with `x-options`: a box for each option, then a ticked box for each
 * chosen value the options don't list (from a default, an agent, or a runbook
 * since edited), so none is dropped unseen. The choices keep that order.
 */
function ChoicesControl({ id, labelId, field, value, onChange }: ControlProps) {
  const options = field.options ?? []
  const chosen = isList(value) ? value : []
  const unlisted = chosen.filter((each) => typeof each !== "string" || !options.includes(each))
  const boxes: ReadonlyArray<FieldValue> = [...options, ...unlisted]
  return (
    <div id={id} className="form-choices" role="group" aria-labelledby={labelId}>
      {boxes.map((box, index) => (
        <label key={index}>
          <input
            type="checkbox"
            checked={chosen.includes(box)}
            disabled={field.readOnly}
            onChange={(event) =>
              onChange(
                boxes.filter((each) =>
                  each === box ? event.target.checked : chosen.includes(each),
                ),
              )
            }
          />
          {index < options.length && typeof box === "string"
            ? (field.optionLabels?.[box] ?? box)
            : `${textOf(box)} (not an option)`}
        </label>
      ))}
    </div>
  )
}

/** Entries, each with a button that removes it, unless the field is read-only. */
function EntryList({
  entries,
  readOnly,
  onRemove,
}: {
  readonly entries: ReadonlyArray<{ readonly name: string; readonly shown: string }>
  readonly readOnly: boolean
  readonly onRemove: (index: number) => void
}) {
  if (entries.length === 0) return null
  return (
    <ul className="form-entry-list">
      {entries.map(({ name, shown }, index) => (
        <li key={index}>
          <span>{shown}</span>
          {readOnly ? null : (
            <button type="button" aria-label={`Remove ${name}`} onClick={() => onRemove(index)}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** A list: a box to type an entry, added with Enter or Add, then its entries. */
function ListControl({ id, field, value, onChange }: ControlProps) {
  const items = isList(value) ? value : []
  const [text, setText] = useState("")
  const add = () => {
    const item = text.trim()
    if (item === "") return
    onChange([...items, item])
    setText("")
  }
  return (
    <div className="form-entries">
      {field.readOnly ? null : (
        <div className="form-entry-add">
          <input
            type="text"
            id={id}
            placeholder="Type an entry and press Enter..."
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              add()
            }}
          />
          <button type="button" onClick={add}>
            Add
          </button>
        </div>
      )}
      <EntryList
        entries={items.map((item) => ({ name: textOf(item), shown: textOf(item) }))}
        readOnly={field.readOnly}
        onRemove={(index) => onChange(items.filter((_, at) => at !== index))}
      />
    </div>
  )
}

/** A map of names to text: a key and a value, added with Add, then its entries. */
function MapControl({ id, field, value, onChange }: ControlProps) {
  const map = isEntries(value) ? value : {}
  const [key, setKey] = useState("")
  const [text, setText] = useState("")
  const add = () => {
    if (key.trim() === "" || text.trim() === "") return
    onChange({ ...map, [key.trim()]: text.trim() })
    setKey("")
    setText("")
  }
  const entries = Object.entries(map)
  return (
    <div className="form-entries">
      {field.readOnly ? null : (
        <div className="form-entry-add">
          <input
            type="text"
            id={id}
            placeholder="Key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <input
            type="text"
            placeholder="Value"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="button" onClick={add}>
            Add
          </button>
        </div>
      )}
      <EntryList
        entries={entries.map(([name, entry]) => ({ name, shown: `${name}: ${textOf(entry)}` }))}
        readOnly={field.readOnly}
        onRemove={(index) => onChange(Object.fromEntries(entries.filter((_, at) => at !== index)))}
      />
    </div>
  )
}

/** The element types of a list's or map's `x-schema`, in the key order given. */
const schemaOf = (field: FieldView): ReadonlyArray<readonly [string, FieldView["type"]]> =>
  Object.entries(field.schema ?? {})

/**
 * A map with an `x-schema`: Add opens a new entry, its name (labelled as the
 * field's `schemaInstanceLabel` says) and a box for each of the schema's
 * fields, which Save Entry adds. Each field's value is text, a true/false
 * one "false" until chosen, as today's form keeps them.
 */
function EntriesControl({ id, labelId, field, value, onChange }: ControlProps) {
  const map = isEntries(value) ? value : {}
  const schema = schemaOf(field)
  const [adding, setAdding] = useState<{
    readonly key: string
    readonly values: Readonly<Record<string, string>>
  }>()
  const entries = Object.entries(map)
  const save = (key: string, values: Readonly<Record<string, string>>) => {
    // In the schema's order; a field left empty is left out, a true/false one is "false".
    const entry = schema.flatMap(([name, type]) => {
      const set = values[name] ?? (type === "bool" ? "false" : undefined)
      return set === undefined ? [] : [[name, set] as const]
    })
    onChange({ ...map, [key.trim()]: Object.fromEntries(entry) })
    setAdding(undefined)
  }
  return (
    <div id={id} className="form-entries" role="group" aria-labelledby={labelId}>
      {field.readOnly ? null : adding === undefined ? (
        <button type="button" onClick={() => setAdding({ key: "", values: {} })}>
          Add
        </button>
      ) : (
        <fieldset className="form-entry-new">
          <legend>New Entry</legend>
          <label htmlFor={`${id}-key`}>
            {field.schemaInstanceLabel ?? "Entry name"} <span className="form-required">*</span>
          </label>
          <input
            type="text"
            id={`${id}-key`}
            value={adding.key}
            onChange={(event) => setAdding({ ...adding, key: event.target.value })}
          />
          {schema.map(([name, type]) => {
            const shown = adding.values[name] ?? ""
            const set = (text: string) =>
              setAdding({ ...adding, values: { ...adding.values, [name]: text } })
            return (
              <div key={name} className="form-entry-field">
                <label htmlFor={`${id}-${name}`}>{`${name} (${type})`}</label>
                {type === "bool" ? (
                  <select
                    id={`${id}-${name}`}
                    value={shown === "" ? "false" : shown}
                    onChange={(event) => set(event.target.value)}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    type={type === "int" || type === "float" ? "number" : "text"}
                    id={`${id}-${name}`}
                    value={shown}
                    onChange={(event) => set(event.target.value)}
                  />
                )}
              </div>
            )
          })}
          <div className="form-entry-actions">
            <button
              type="button"
              disabled={adding.key.trim() === ""}
              onClick={() => save(adding.key, adding.values)}
            >
              Save Entry
            </button>
            <button type="button" onClick={() => setAdding(undefined)}>
              Cancel
            </button>
          </div>
        </fieldset>
      )}
      <EntryList
        entries={entries.map(([name, entry]) => ({
          name,
          shown: isEntries(entry)
            ? `${name}: ${Object.entries(entry)
                .map(([key, inner]) => `${key}: ${textOf(inner)}`)
                .join(", ")}`
            : `${name}: ${textOf(entry)}`,
        }))}
        readOnly={field.readOnly}
        onRemove={(index) => onChange(Object.fromEntries(entries.filter((_, at) => at !== index)))}
      />
    </div>
  )
}

/**
 * A list with an `x-schema`: a tuple, one box per element in position order,
 * the order an object's whole-number keys ("0", "1") always come in.
 */
function TupleControl({ id, labelId, field, value, onChange }: ControlProps) {
  const elements = schemaOf(field)
  const items = elements.map(
    ([, type], index) =>
      (isList(value) ? value[index] : undefined) ?? (type === "bool" ? false : ""),
  )
  const set = (index: number, item: FieldValue) =>
    onChange(items.map((before, at) => (at === index ? item : before)))
  return (
    <div id={id} className="form-tuple" role="group" aria-labelledby={labelId}>
      {elements.map(([position, type], index) => {
        const elementId = `${id}-${position}`
        const item = items[index]
        return (
          <div key={position} className="form-entry-field">
            <label htmlFor={elementId}>{elementLabel(type)}</label>
            {type === "int" || type === "float" ? (
              <NumberBox
                id={elementId}
                value={typeof item === "number" ? item : ""}
                parse={type === "int" ? (text) => parseInt(text, 10) : parseFloat}
                step={type === "float" ? "any" : undefined}
                disabled={field.readOnly}
                onChange={(number) => set(index, number)}
              />
            ) : type === "bool" ? (
              <select
                id={elementId}
                value={String(item === true)}
                disabled={field.readOnly}
                onChange={(event) => set(index, event.target.value === "true")}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type="text"
                id={elementId}
                value={textOf(item)}
                disabled={field.readOnly}
                onChange={(event) => set(index, event.target.value)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** What a tuple element's box asks for, as today's form says it. */
function elementLabel(type: FieldView["type"]): string {
  switch (type) {
    case "int":
      return "Enter an integer"
    case "float":
      return "Enter a float"
    case "bool":
      return "Enter a boolean"
    case "string":
    case "list":
    case "map":
    case "enum":
      return `Enter a ${type}`
    default: {
      const unhandled: never = type
      throw new Error(`The form has no label for a tuple element of ${String(unhandled)}.`)
    }
  }
}
