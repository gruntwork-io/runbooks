import { useState } from "react"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { enteredValuesChanged, restoreEnteredValues, type LinkedField } from "@/lib/sessionHistory"
import { chipKeysIn, withEnteredValues } from "../lib/templateValue"

const NOTHING_ENTERED: Readonly<Record<string, string>> = {}

export interface UseEnteredValuesReturn {
  /** What the field's control shows: its linked value, whose chips show the values entered for them. */
  shown: (name: string) => unknown
  /** The values entered in place of the field's chips, by chip key. */
  entered: (name: string) => Readonly<Record<string, string>>
  /** Use `value` in place of what the field's chip with this key links to. */
  enter: (name: string, key: string, value: string) => void
  /** Go back to what the field's chip with this key links to. */
  reset: (name: string, key: string) => void
  /** The field's control changed what it shows to `shown`, as when a list entry is removed. */
  change: (name: string, shown: unknown) => void
  /** Give the field `value`, dropping the values entered for its chips, as resetting it to its default does. */
  replace: (name: string, value: unknown) => void
}

/**
 * The values a form's user entered in place of the chips of its linked values
 * (see TemplateValueText). Such a field's value is its linked value with the
 * entered values in place of their chips (withEnteredValues): what the form
 * renders and submits. Its control shows the linked value, so each chip can be
 * reset. They're kept in the session's history, so a resumed session still
 * has them.
 *
 * `values` are the form's values, and `setValue` changes one. A field whose
 * value changes some other way, as one imported from another block does,
 * leaves the values entered for it behind.
 */
export function useEnteredValues(
  blockId: string,
  values: Record<string, unknown>,
  setValue: (name: string, value: unknown) => void,
): UseEnteredValuesReturn {
  const history = useSessionHistory()
  const [fields, setFields] = useState<Record<string, LinkedField>>(() =>
    restoreEnteredValues(history.saved(blockId, "overrides")),
  )

  // The field's linked value and entered values, while its value is still the one they make
  const current = (name: string): LinkedField | undefined => {
    const field = fields[name]
    return field !== undefined &&
      JSON.stringify(withEnteredValues(field.linked, field.entered)) ===
        JSON.stringify(values[name])
      ? field
      : undefined
  }

  // Give the field the value `linked` makes with the entered values its chips still show
  const update = (name: string, linked: unknown, entered: Record<string, string>) => {
    const keys = chipKeysIn(linked)
    const kept = Object.fromEntries(Object.entries(entered).filter(([key]) => keys.has(key)))
    const { [name]: _previous, ...others } = fields
    const next =
      Object.keys(kept).length > 0 ? { ...others, [name]: { linked, entered: kept } } : others
    setFields(next)
    history.record(blockId, "overrides", enteredValuesChanged(next))
    setValue(name, withEnteredValues(linked, kept))
  }

  return {
    shown: (name) => current(name)?.linked ?? values[name],
    entered: (name) => current(name)?.entered ?? NOTHING_ENTERED,
    enter: (name, key, value) => {
      const field = current(name)
      update(name, field?.linked ?? values[name], { ...field?.entered, [key]: value })
    },
    reset: (name, key) => {
      const field = current(name)
      if (field === undefined) return
      const { [key]: _reset, ...entered } = field.entered
      update(name, field.linked, entered)
    },
    change: (name, shown) => {
      if (fields[name] === undefined) setValue(name, shown)
      else update(name, shown, current(name)?.entered ?? {})
    },
    replace: (name, value) => {
      if (fields[name] !== undefined) {
        const { [name]: _dropped, ...others } = fields
        setFields(others)
        history.record(blockId, "overrides", enteredValuesChanged(others))
      }
      setValue(name, value)
    },
  }
}
