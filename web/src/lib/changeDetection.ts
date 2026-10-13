/**
 * Returns a stable string key for a set of values.
 * When the key changes, the values have changed. Object key order does not
 * affect the key.
 */
export function computeChangeKey(...values: unknown[]): string {
  return JSON.stringify(values, sortObjectKeys)
}

/** JSON.stringify replacer that writes an object's keys in sorted order. */
function sortObjectKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key]
  }
  return sorted
}
