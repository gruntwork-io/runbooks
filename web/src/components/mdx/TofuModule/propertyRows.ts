import {
  isHiddenValue,
  type HiddenValue,
  type PropertyValue,
} from "../../../../../src/domain/tofu-module/run"

/** A value with nothing inside it: text, a number, a flag, null, or a hidden value. */
export type Leaf = string | number | boolean | null | HiddenValue

/** One value of a resource, at its path, as the plan has it before and after. */
export interface PropertyRow {
  /** Where the value is, such as `group_key[0].id`. */
  readonly path: string
  /** Its value after the change; none when the change removes it. */
  readonly after?: Leaf | undefined
  /** Its value before the change; none for a value the change adds. */
  readonly before?: Leaf | undefined
  /** Whether the change sets it: always, for a resource the plan creates. */
  readonly changed: boolean
}

/** What the person narrowed a resource's properties to. */
export interface PropertyFilter {
  readonly query: string
  readonly hideUnknown: boolean
  readonly onlyChanged: boolean
}

export const NO_FILTER: PropertyFilter = { query: "", hideUnknown: false, onlyChanged: false }

type Properties = Readonly<Record<string, PropertyValue>>

const IDENTIFIER = /^[A-Za-z_][\w-]*$/

/** A key as HCL writes it: bare when it can be, quoted otherwise. */
export const keyText = (key: string) => (IDENTIFIER.test(key) ? key : JSON.stringify(key))

/** The path of a value inside `parent`, by key or list index. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`
  if (!IDENTIFIER.test(key)) return `${parent}[${JSON.stringify(key)}]`
  return parent ? `${parent}.${key}` : key
}

const isLeaf = (value: PropertyValue | undefined): value is Leaf =>
  value === null || typeof value !== "object" || isHiddenValue(value)

export const isUnknown = (value: Leaf | undefined) =>
  isHiddenValue(value) && value.hidden === "known after apply"

/** A leaf as the person reads it: text without quotes, a hidden value as what hides it. */
export function leafText(value: Leaf): string {
  if (isHiddenValue(value)) return value.hidden
  return typeof value === "string" ? value : JSON.stringify(value)
}

const sameLeaf = (a: Leaf | undefined, b: Leaf | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)

/** Every leaf of a resource's properties, before and after, in the order the plan has them. */
export function propertyRows(after: Properties, before?: Properties): PropertyRow[] {
  const rows: PropertyRow[] = []
  const walk = (a: PropertyValue | undefined, b: PropertyValue | undefined, path: string) => {
    const aLeaf = a === undefined || isLeaf(a)
    const bLeaf = b === undefined || isLeaf(b)
    if (aLeaf && bLeaf) {
      // Most of a resource's attributes are unset; a top-level one that's empty says nothing.
      const empty = (v: Leaf | undefined) =>
        v === undefined || v === null || (v === "" && !/[.[]/.test(path))
      if (empty(a) && empty(b)) return
      rows.push({
        path,
        after: a,
        before: b,
        changed: before === undefined || !sameLeaf(a, b),
      })
      return
    }
    const list = (v: PropertyValue | undefined) => (Array.isArray(v) ? v : undefined)
    const map = (v: PropertyValue | undefined) =>
      v !== null && typeof v === "object" && !Array.isArray(v) && !isHiddenValue(v)
        ? (v as Properties)
        : undefined
    if (list(a) || list(b)) {
      const length = Math.max(list(a)?.length ?? 0, list(b)?.length ?? 0)
      for (let i = 0; i < length; i++) walk(list(a)?.[i], list(b)?.[i], childPath(path, i))
    } else {
      const keys = new Set([...Object.keys(map(a) ?? {}), ...Object.keys(map(b) ?? {})])
      for (const key of keys) walk(map(a)?.[key], map(b)?.[key], childPath(path, key))
    }
    // A leaf on one side and a list or map on the other: the leaf is a row of its own.
    if (aLeaf && a !== undefined) walk(a, undefined, path)
    if (bLeaf && b !== undefined) walk(undefined, b, path)
  }
  const keys = new Set([...Object.keys(after), ...Object.keys(before ?? {})])
  for (const key of keys) walk(after[key], before?.[key], childPath("", key))
  return rows
}

/** Whether a row's path or either of its values contains the query, ignoring case. */
function matches(row: PropertyRow, query: string): boolean {
  const needle = query.toLowerCase()
  const values = [row.after, row.before].filter((v): v is Leaf => v !== undefined).map(leafText)
  return [row.path, ...values].some((text) => text.toLowerCase().includes(needle))
}

/** The rows the filter keeps. A resource whose address matches the query keeps them all. */
export function filterRows(
  rows: readonly PropertyRow[],
  filter: PropertyFilter,
  address: string,
): PropertyRow[] {
  const query = filter.query.trim()
  const byAddress = query !== "" && address.toLowerCase().includes(query.toLowerCase())
  return rows.filter(
    (row) =>
      !(filter.hideUnknown && isUnknown(row.after)) &&
      !(filter.onlyChanged && !row.changed) &&
      (query === "" || byAddress || matches(row, query)),
  )
}
