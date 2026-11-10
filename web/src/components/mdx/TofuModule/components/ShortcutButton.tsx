import { UserPlus } from "lucide-react"
import type { TofuModuleShortcut } from "../../../../../../src/domain/tofu-module/types"
import { useLookup } from "../hooks/useLookup"
import { suggestionFor } from "../lookupRows"

interface ShortcutButtonProps {
  shortcut: TofuModuleShortcut
  /** The values the input holds already; the button hides once its value is one of them. */
  current: readonly string[]
  onAdd: (value: string) => void
}

/**
 * A button that fills an input from the first row of a lookup, such as the
 * signed-in person for "Add Ana Lima as an owner". It stays hidden while the
 * lookup has no row, so a failed lookup costs the form nothing.
 */
export function ShortcutButton({ shortcut, current, onAdd }: ShortcutButtonProps) {
  const { rows } = useLookup(shortcut.from, "", true)
  const row = rows[0]
  if (!row) return null
  let suggestion
  try {
    suggestion = suggestionFor(shortcut, row)
  } catch {
    // runbooks.yml's templates were checked when the module loaded.
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
