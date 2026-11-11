/**
 * A block's inputs as a key that equal values always share, whatever their
 * key order, so generated code, a plan, or a pull request can be matched
 * with the inputs it was made for.
 */
export function inputsKey(values: Record<string, unknown>): string {
  return JSON.stringify(values, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}
