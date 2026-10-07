/** Whether the renderer runs on macOS, where shortcuts use ⌘ and the window controls sit top-left. */
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)

/**
 * A keyboard shortcut as the platform shows it: "⇧⌘O" on macOS, "Ctrl+Shift+O"
 * elsewhere. `key` is a single printable key, upper case.
 */
export function formatShortcut(key: string, { shift = false }: { shift?: boolean } = {}): string {
  if (isMac) return `${shift ? "⇧" : ""}⌘${key}`
  return `Ctrl+${shift ? "Shift+" : ""}${key}`
}
