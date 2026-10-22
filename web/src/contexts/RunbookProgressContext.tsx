import { useMemo, useState, type ReactNode } from "react"
import {
  ProgressRegistryContext,
  RunbookProgressContext,
  type ProgressRegistry,
} from "./RunbookProgressContext.types"

/**
 * Counts the steps of the open runbook, and how many of them are done, for the
 * progress bar under the Header. Each block that shows whether it is done
 * counts itself while it is mounted (see useProgressStep), so the count
 * follows the runbook on the page: opening another runbook or session swaps
 * its blocks, and the count with them.
 */
export function RunbookProgressProvider({ children }: { children: ReactNode }) {
  // Whether each mounted step is done, keyed by the step's useId()
  const [steps, setSteps] = useState<Readonly<Record<string, boolean>>>({})

  const registry = useMemo<ProgressRegistry>(
    () => ({
      reportStep: (key, done) => {
        setSteps((prev) => (prev[key] === done ? prev : { ...prev, [key]: done }))
      },
      removeStep: (key) => {
        setSteps((prev) => {
          if (!(key in prev)) return prev
          const { [key]: _removed, ...rest } = prev
          return rest
        })
      },
    }),
    [],
  )

  const states = Object.values(steps)
  const total = states.length
  const done = states.filter(Boolean).length
  const progress = useMemo(() => ({ total, done }), [total, done])

  return (
    <ProgressRegistryContext.Provider value={registry}>
      <RunbookProgressContext.Provider value={progress}>{children}</RunbookProgressContext.Provider>
    </ProgressRegistryContext.Provider>
  )
}
