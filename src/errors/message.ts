/**
 * The text to show for a caught value: an Error's message, or the value itself
 * when something other than an Error was thrown. A plain object is
 * JSON-encoded rather than printed as "[object Object]".
 *
 * Has no imports so the renderer can use it without bundling Effect.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err)
    } catch {
      return "unserializable error"
    }
  }
  return String(err)
}
