import { useContext, useEffect, useId } from "react"
import { ProgressRegistryContext } from "@/contexts/RunbookProgressContext.types"

/**
 * Counts the calling component as one step of the runbook's progress, done or
 * not, for as long as it is mounted. Does nothing outside a
 * RunbookProgressProvider.
 *
 * Blocks count through <ProgressStep>, which they render with the UI that
 * shows whether they are done, so a block that shows an error in its place
 * is not a step.
 */
export function useProgressStep(done: boolean): void {
  const registry = useContext(ProgressRegistryContext)
  const key = useId()

  useEffect(() => {
    if (!registry) return
    return () => registry.removeStep(key)
  }, [registry, key])

  useEffect(() => {
    registry?.reportStep(key, done)
  }, [registry, key, done])
}
