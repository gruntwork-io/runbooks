import { useState, useCallback, useContext } from 'react'
import { RunbookContext } from '@/contexts/RunbookContext'

/**
 * localStorage key for a markdown task-list checkbox's state. Scoped to the
 * runbook (when available) so the same checkbox key in different runbooks
 * doesn't share state.
 */
function storageKey(runbookName: string | undefined, taskKey: string): string {
  return `task-checkbox:${runbookName ?? 'default'}:${taskKey}`
}

/**
 * Tracks the checked state of a GitHub-flavored-markdown task-list checkbox
 * (`- [ ]` / `- [x]`). The markdown supplies the *initial* state; once the user
 * toggles a box we persist their explicit choice to localStorage (storing both
 * `true` and `false` so a user un-check overrides a markdown default), keyed by
 * runbook + a stable per-checkbox key, so progress survives reloads.
 *
 * Reads the runbook name directly from RunbookContext (non-throwing) so it also
 * works in lightweight test renders.
 */
export function useTaskCheckbox(taskKey: string, initialChecked: boolean) {
  const runbookName = useContext(RunbookContext)?.runbookName
  const key = storageKey(runbookName, taskKey)

  const [checked, setChecked] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored === 'true') return true
      if (stored === 'false') return false
    } catch {
      /* localStorage unavailable — fall back to the markdown's initial state */
    }
    return initialChecked
  })

  const toggle = useCallback(() => {
    setChecked((prev) => {
      const next = !prev
      try {
        localStorage.setItem(key, String(next))
      } catch {
        /* localStorage unavailable — toggle won't persist across launches */
      }
      return next
    })
  }, [key])

  return { checked, toggle }
}
