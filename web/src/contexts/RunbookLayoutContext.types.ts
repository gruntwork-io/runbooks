import { createContext } from "react"

/**
 * How wide the runbook is on a desktop window. 'fixed' keeps the runbook and
 * the files workspace at their capped widths; 'fill' lets them fill the window.
 */
export type RunbookLayout = "fixed" | "fill"

/** User-facing name of the setting. */
export const RUNBOOK_LAYOUT_NAME = "Runbook width"

/** User-facing name of each choice. */
export const RUNBOOK_LAYOUT_LABELS: Record<RunbookLayout, string> = {
  fixed: "Fixed",
  fill: "Fill window",
}

export interface RunbookLayoutContextValue {
  /** The runbook's width setting. Default 'fixed'. */
  layout: RunbookLayout
  /** Update the setting. Persists to localStorage. */
  setLayout: (layout: RunbookLayout) => void
}

export const RunbookLayoutContext = createContext<RunbookLayoutContextValue | undefined>(undefined)

/**
 * localStorage key for the persisted runbook width setting.
 * Mirrors the THEME_STORAGE_KEY precedent in ThemeContext.types.ts.
 */
export const RUNBOOK_LAYOUT_STORAGE_KEY = "runbooks-runbook-layout"
