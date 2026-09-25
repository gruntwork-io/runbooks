import { useState, useCallback, useContext } from 'react'
import { RunbookContext } from '@/contexts/RunbookContext'
import { runbookStorageKey } from '../lib/runbookStorageKey'

/**
 * Tracks whether the user has marked an instruction-mode block as done, persisted
 * to localStorage so finished steps stay marked across reloads and across
 * toggling instruction mode off and on. The key is scoped to the runbook's
 * identity (`storageScope`) so the same block id in different runbooks doesn't
 * share state. Reads it directly from RunbookContext (non-throwing) so it also
 * works in lightweight test renders.
 */
export function useBlockCompletion(id: string) {
  const storageScope = useContext(RunbookContext)?.storageScope
  const key = runbookStorageKey('instruction-done', storageScope, id)

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
