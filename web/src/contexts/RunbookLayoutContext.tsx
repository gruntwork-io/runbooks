import { useState, useCallback, useMemo, type ReactNode } from "react"
import {
  RunbookLayoutContext,
  RUNBOOK_LAYOUT_STORAGE_KEY,
  type RunbookLayout,
} from "./RunbookLayoutContext.types"

/** Read the persisted setting, defaulting to 'fixed'. */
function readStoredLayout(): RunbookLayout {
  try {
    return localStorage.getItem(RUNBOOK_LAYOUT_STORAGE_KEY) === "fill" ? "fill" : "fixed"
  } catch {
    /* localStorage unavailable (e.g. private mode) */
    return "fixed"
  }
}

/**
 * Provides the runbook width setting. Modeled on InstructionModeProvider: one
 * preference persisted to localStorage, 'fixed' by default, read entirely in
 * the renderer to size the runbook and the files workspace.
 */
export function RunbookLayoutProvider({ children }: { children: ReactNode }) {
  const [layout, setLayoutState] = useState<RunbookLayout>(readStoredLayout)

  const setLayout = useCallback((next: RunbookLayout) => {
    try {
      localStorage.setItem(RUNBOOK_LAYOUT_STORAGE_KEY, next)
    } catch {
      /* localStorage unavailable — the setting won't persist across launches */
    }
    setLayoutState(next)
  }, [])

  const value = useMemo(() => ({ layout, setLayout }), [layout, setLayout])

  return <RunbookLayoutContext.Provider value={value}>{children}</RunbookLayoutContext.Provider>
}
