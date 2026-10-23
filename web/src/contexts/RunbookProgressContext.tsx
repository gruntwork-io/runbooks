import type { ReactNode } from "react"
import { ProgressRegistryContext, RunbookProgressContext } from "./RunbookProgressContext.types"
import { useStepCounter } from "./useStepCounter"

/**
 * Counts the steps of the open runbook, and how many of them are done, for the
 * progress bar under the Header. Each block that shows whether it is done
 * counts itself while it is mounted (see useProgressStep), so the count
 * follows the runbook on the page: opening another runbook or session swaps
 * its blocks, and the count with them.
 */
export function RunbookProgressProvider({ children }: { children: ReactNode }) {
  const [progress, registry] = useStepCounter()

  return (
    <ProgressRegistryContext.Provider value={registry}>
      <RunbookProgressContext.Provider value={progress}>{children}</RunbookProgressContext.Provider>
    </ProgressRegistryContext.Provider>
  )
}
