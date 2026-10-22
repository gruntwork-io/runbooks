import { createContext } from "react"

/** How far the user is through the open runbook. */
export interface RunbookProgress {
  /** The steps on the page: the blocks that show whether they are done. */
  total: number
  /** How many of them are done. */
  done: number
}

/** What a step uses to count itself in the runbook's progress. */
export interface ProgressRegistry {
  /** Records whether the step mounted as `key` is done, adding it if it is new. */
  reportStep: (key: string, done: boolean) => void
  /** Removes the step mounted as `key`. */
  removeStep: (key: string) => void
}

/** The runbook's progress. Outside a RunbookProgressProvider, no steps. */
export const RunbookProgressContext = createContext<RunbookProgress>({ total: 0, done: 0 })

/**
 * Kept apart from RunbookProgressContext so the steps, which only report,
 * don't re-render each time one of them is done.
 */
export const ProgressRegistryContext = createContext<ProgressRegistry | undefined>(undefined)
