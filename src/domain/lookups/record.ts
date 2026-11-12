/**
 * Turns a real API answer into a sample a simulation can replay. A sample
 * needs the response's shape and a few rows, not real data, so by default it
 * keeps three rows, only the paths the lookup or check reads, and replaces
 * every value with a placeholder of the same type, such as
 * `user-1@example.com`.
 */
import { isMissing, readPath } from "./response.ts"
import type { CheckDef, LookupDef } from "./types.ts"

/** How many rows a recorded sample keeps. */
export const RECORDED_ROWS = 3

export interface RecordOptions {
  /** Keep the real values of the rows that are kept. */
  readonly keepValues: boolean
}

/** The part of a lookup's first page that its rows and fields read. Paging is left out, so the sample is one page. */
export function sampleLookupResponse(
  def: LookupDef,
  response: unknown,
  options: RecordOptions,
): unknown {
  const items = def.rows ? readPath(response, def.rows) : [response]
  const list = Array.isArray(items) ? items.slice(0, RECORDED_ROWS) : []
  const rows = list.map((item, i) => {
    const row = {}
    for (const [field, path] of Object.entries(def.fields)) {
      const value = readPath(item, path)
      if (isMissing(value)) continue
      setAt(row, path, options.keepValues ? value : placeholder(value, field, i + 1))
    }
    return row
  })
  if (!def.rows) return rows[0] ?? {}
  return setAt({}, def.rows, rows)
}

/** The part of a check's response that its expectation reads. */
export function sampleCheckResponse(
  def: CheckDef,
  response: unknown,
  options: RecordOptions,
): unknown {
  const value = readPath(response, def.expect.path)
  if (isMissing(value)) return {}
  let sample: unknown
  if ("equals" in def.expect || options.keepValues) {
    // The expected value is the check's own constant, such as ENABLED: no secret.
    sample = Array.isArray(value) ? value.slice(0, RECORDED_ROWS) : value
  } else if (Array.isArray(value)) {
    sample = value.slice(0, RECORDED_ROWS).map((item, i) => placeholder(item, "item", i + 1))
  } else {
    sample = placeholder(value, "value", 1)
  }
  return setAt({}, def.expect.path, sample)
}

/** A value of the same type as `value` that says nothing about it. */
export function placeholder(value: unknown, field: string, n: number): unknown {
  if (typeof value === "string") {
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return `user-${n}@example.com`
    if (/^https?:\/\//.test(value)) return `https://example.com/${field}-${n}`
    return `${field}-${n}`
  }
  if (typeof value === "number") return n
  if (typeof value === "boolean") return value
  if (Array.isArray(value))
    return value.slice(0, RECORDED_ROWS).map((item, i) => placeholder(item, field, i + 1))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, placeholder(item, key, n)]),
    )
  }
  return value
}

/** Set `path` in `root`, making objects on the way, and return `root`. */
function setAt(root: object, path: string, value: unknown): object {
  const keys = path.split(".")
  let node = root as Record<string, unknown>
  keys.slice(0, -1).forEach((key) => {
    const child = node[key]
    node[key] = typeof child === "object" && child !== null ? child : {}
    node = node[key] as Record<string, unknown>
  })
  const last = keys.at(-1)
  if (last !== undefined) node[last] = value
  return root
}
