import { UserPlus } from "lucide-react"
import type { ShortcutUse } from "../../../../../../../src/domain/lookups/types"
import { useLookup } from "../../hooks/useLookup"
import { suggestionFor } from "../../lib/lookupRows"

interface ShortcutButtonProps {
  shortcut: ShortcutUse
  /** The values the input holds already; the button hides once its value is one of them. */
  current: readonly string[]
  onAdd: (value: string) => void
}

/**
 * A button that fills an input from a lookup's one row, such as the
 * signed-in person for "Add Ana Lima as an owner". It stays hidden unless the
 * lookup gives exactly one row, so a failed lookup costs the form nothing.
 */
export function ShortcutButton({ shortcut, current, onAdd }: ShortcutButtonProps) {
  const { rows } = useLookup(shortcut, "", true)
  const row = rows.length === 1 ? rows[0] : undefined
  if (!row) return null
  let suggestion
  try {
    suggestion = suggestionFor(row, shortcut.label)
  } catch {
    // The label's template was checked when its file loaded.
    return null
  }
  if (!suggestion.value || current.includes(suggestion.value)) return null
  return (
    <button
      type="button"
      onClick={() => onAdd(suggestion.value)}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-sm text-foreground hover:bg-accent"
    >
      <UserPlus className="size-3.5 text-muted-foreground" />
      {suggestion.label}
    </button>
  )
}
