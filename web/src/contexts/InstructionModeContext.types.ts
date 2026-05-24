import { createContext } from 'react'

/**
 * User-facing name for the mode. Centralized so the final naming decision
 * (PRD §9 / spec §11 — "Instruction mode" recommended) is a one-line change.
 */
export const INSTRUCTION_MODE_NAME = 'Instruction mode'

/**
 * Banner copy shown at the top of a runbook while the mode is on. Centralized
 * alongside the name so a rename touches one place.
 */
export const INSTRUCTION_MODE_BANNER_TEXT =
  'Instruction mode — nothing here runs automatically. Each step shows the exact command to copy and run yourself.'

export interface InstructionModeContextValue {
  /** Whether instruction mode is on. Default false (interactive). */
  enabled: boolean
  /** Update the preference. Persists to localStorage. */
  setEnabled: (enabled: boolean) => void
}

export const InstructionModeContext = createContext<
  InstructionModeContextValue | undefined
>(undefined)

/**
 * localStorage key for the persisted instruction-mode preference.
 * Mirrors the THEME_STORAGE_KEY precedent in ThemeContext.types.ts.
 */
export const INSTRUCTION_MODE_STORAGE_KEY = 'runbooks-instruction-mode'
