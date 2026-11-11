import { renderRowTemplate, type LookupRow } from "../../../../../src/domain/tf-module/rowTemplate"
import type { TfModuleLookup } from "../../../../../src/domain/tf-module/types"

/** A lookup row as a suggestion: the value it puts in the input, and what the list shows. */
export interface Suggestion {
  value: string
  label: string
  /** A second, quieter line, from the row's `description` field. */
  detail?: string
  row: LookupRow
}

const text = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value)

export function suggestionFor(lookup: TfModuleLookup, row: LookupRow): Suggestion {
  const value = text(row[lookup.value ?? "value"])
  const label = lookup.label ? renderRowTemplate(lookup.label, row) : text(row.label) || value
  const detail = text(row.description)
  return { value, label, ...(detail ? { detail } : {}), row }
}

/** The other inputs a pick fills in, from the lookup's `sets`. */
export function valuesFromPick(lookup: TfModuleLookup, row: LookupRow): Record<string, string> {
  return Object.fromEntries(
    Object.entries(lookup.sets ?? {}).map(([name, template]) => [
      name,
      renderRowTemplate(template, row),
    ]),
  )
}
