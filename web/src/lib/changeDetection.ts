/**
 * Returns a stable string key for a set of values.
 * When the key changes, the values have changed.
 */
export function computeChangeKey(...values: unknown[]): string {
  return JSON.stringify(values)
}
