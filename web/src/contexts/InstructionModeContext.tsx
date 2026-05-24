import { useState, useCallback, useMemo, type ReactNode } from 'react'
import {
  InstructionModeContext,
  INSTRUCTION_MODE_STORAGE_KEY,
} from './InstructionModeContext.types'

/** Read the persisted preference, defaulting to false (interactive mode). */
function readStoredEnabled(): boolean {
  try {
    return localStorage.getItem(INSTRUCTION_MODE_STORAGE_KEY) === 'true'
  } catch {
    /* localStorage unavailable (e.g. private mode) */
    return false
  }
}

/**
 * Provides the app's instruction-mode state. Modeled on ThemeProvider: a single
 * boolean preference persisted to localStorage, off by default, instantly
 * reversible. Unlike theme there is no native-chrome side effect — the flag is
 * read entirely in the renderer to decide whether blocks render their
 * interactive UI or a flattened, copy-pasteable instruction.
 */
export function InstructionModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(readStoredEnabled)

  const setEnabled = useCallback((next: boolean) => {
    try {
      localStorage.setItem(INSTRUCTION_MODE_STORAGE_KEY, String(next))
    } catch {
      /* localStorage unavailable — preference won't persist across launches */
    }
    setEnabledState(next)
  }, [])

  const value = useMemo(() => ({ enabled, setEnabled }), [enabled, setEnabled])

  return (
    <InstructionModeContext.Provider value={value}>
      {children}
    </InstructionModeContext.Provider>
  )
}
