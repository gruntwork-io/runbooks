import { useState, useCallback, useContext } from 'react'
import { RunbookContext } from '@/contexts/RunbookContext'
import { runbookStorageKey } from '../lib/runbookStorageKey'

/**
 * Tracks the checked state of a GitHub-flavored-markdown task-list checkbox
 * (`- [ ]` / `- [x]`). The markdown supplies the *initial* state; once the user
 * toggles a box we persist their explicit choice to localStorage (storing both
 * `true` and `false` so a user un-check overrides a markdown default), keyed by
 * the runbook's identity (`storageScope`) + a stable per-checkbox key, so
 * progress survives reloads and the same checkbox in different runbooks
 * doesn't share state.
 *
 * Reads the scope directly from RunbookContext (non-throwing) so it also works
 * in lightweight test renders.
 */
export function useTaskCheckbox(taskKey: string, initialChecked: boolean) {
  const storageScope = useContext(RunbookContext)?.storageScope
  const key = runbookStorageKey('task-checkbox', storageScope, taskKey)

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
