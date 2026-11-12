/**
 * Reads a response the way a lookup or check declares: a path to the list of
 * rows, and a path to each field in a row. A path is dot-separated keys, with
 * a number for a list item, such as `data.teams.nodes` or `emails.0.address`.
 */
import { valueText } from "./template.ts"
import type { LookupDef, Row } from "./types.ts"

const MISSING = Symbol("missing")

/** The value at `path` in `value`, or MISSING. */
export function readPath(value: unknown, path: string): unknown {
  let node: unknown = value
  for (const key of path.split(".")) {
    if (Array.isArray(node) && /^\d+$/.test(key)) node = node[Number(key)]
    else if (typeof node === "object" && node !== null && Object.hasOwn(node, key)) {
      node = (node as Record<string, unknown>)[key]
    } else return MISSING
    if (node === undefined) return MISSING
  }
  return node
}

export const isMissing = (value: unknown): value is typeof MISSING => value === MISSING

const keysOf = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? Object.keys(value).join(", ") || "none"
    : `none (it's ${valueText(value) || "empty"})`

/**
 * The rows one response gives, with only the lookup's declared fields. APIs
 * often leave an empty field out of a row, such as a group with no
 * description, so a field a row lacks is left out of it, except `value`,
 * which a pick sets the input to: a row without it fails, naming the path.
 */
export function rowsOf(lookup: LookupDef, response: unknown): Row[] {
  let list: unknown[] = [response]
  if (lookup.rows) {
    const found = readPath(response, lookup.rows)
    // An API that has no results often leaves the list out.
    if (isMissing(found) || found === null) return []
    if (!Array.isArray(found)) {
      throw new Error(`${lookup.id}: the response's ${lookup.rows} isn't a list.`)
    }
    list = found
  }
  return list.map((item) => {
    const row: Record<string, unknown> = {}
    for (const [field, path] of Object.entries(lookup.fields)) {
      const value = readPath(item, path)
      if (!isMissing(value)) row[field] = value
      else if (field === "value") throw missingField(lookup, field, path, item)
    }
    return row
  })
}

/** The error for a row that lacks a field it must have. */
export const missingField = (lookup: LookupDef, field: string, path: string, item: unknown) =>
  new Error(
    `${lookup.id}: a row has no ${path}, which field ${field} reads. The row's keys are ${keysOf(item)}.`,
  )

/**
 * The declared fields no row has. Over real or recorded answers, that means
 * a mistake in the field's path, or an API that changed.
 */
export function fieldsNoRowHas(lookup: LookupDef, rows: readonly Row[]): string[] {
  if (rows.length === 0) return []
  return Object.keys(lookup.fields).filter((field) => rows.every((row) => !(field in row)))
}
