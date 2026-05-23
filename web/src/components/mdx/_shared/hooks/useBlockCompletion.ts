import { useState, useCallback, useContext } from 'react'
import { RunbookContext } from '@/contexts/RunbookContext'

/**
 * localStorage key for a block's "done" state. Scoped to the runbook (when
 * available) so the same block id in different runbooks doesn't share state.
 */
function storageKey(runbookName: string | undefined, id: string): string {
  return `instruction-done:${runbookName ?? 'default'}:${id}`
}

/**
 * Tracks whether the user has marked an instruction-mode block as done, persisted
 * to localStorage so finished steps stay marked across reloads and across
 * toggling instruction mode off and on. Reads the runbook name directly from
 * RunbookContext (non-throwing) so it also works in lightweight test renders.
 */
export function useBlockCompletion(id: string) {
  const runbookName = useContext(RunbookContext)?.runbookName
  const key = storageKey(runbookName, id)

  const [completed, setCompleted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) === 'true'
    } catch {
      return false
    }
  })

  const toggle = useCallback(() => {
    setCompleted((prev) => {
      const next = !prev
      try {
        if (next) localStorage.setItem(key, 'true')
        else localStorage.removeItem(key)
      } catch {
        /* localStorage unavailable — completion won't persist across launches */
      }
      return next
    })
  }, [key])

  return { completed, toggle }
}
