import { renderRowTemplate } from "../../../../../src/domain/tf-module/rowTemplate"
import type { Row } from "../../../../../src/domain/lookups/types"

/** A lookup row as a suggestion: the value it puts in the input, and what the list shows. */
export interface Suggestion {
  value: string
  label: string
  /** A second, quieter line, from the row's `description` field. */
  detail?: string
}

const text = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value)

/**
 * A row's `value`, shown by its `label` field and described by its
 * `description` field; `label` replaces the label with a template over the
 * row's fields, such as a shortcut's `Add "{{ .label }}" as an owner`.
 */
export function suggestionFor(row: Row, label?: string): Suggestion {
  const value = text(row.value)
  const shown = label ? renderRowTemplate(label, row) : text(row.label) || value
  const detail = text(row.description)
  return { value, label: shown, ...(detail ? { detail } : {}) }
}

/** Whether a row has a value containing what the user typed, ignoring case. */
export function matchesQuery(row: Row, query: string): boolean {
  if (query === "") return true
  const needle = query.toLowerCase()
  return Object.values(row).some(
    (value) =>
      (typeof value === "string" || typeof value === "number") &&
      String(value).toLowerCase().includes(needle),
  )
}
