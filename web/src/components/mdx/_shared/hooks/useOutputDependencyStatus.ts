import { useCallback } from "react"
import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
import { useAllOutputs } from "@/contexts/useRunbook"
import { computeUnmetOutputDependencies } from "@/lib/templateUtils"
import { outputDependenciesIn } from "../lib/templateValue"

/** Where the block outputs a value's templates use stand. */
export interface OutputDependencyStatus {
  /**
   * Blocks on the page that haven't produced an output the value uses yet,
   * by the id the runbook writes them with. The value is known once they run.
   */
  waitingFor: string[]
  /**
   * Block ids the value's templates use that no block on the page has, as the
   * templates write them. The value can never be filled in: someone has to
   * replace it, or fix the runbook.
   */
  missing: string[]
}

/** Returns a function giving the OutputDependencyStatus of a form value. */
export function useOutputDependencyStatus(): (value: unknown) => OutputDependencyStatus {
  const allOutputs = useAllOutputs()
  const { asWritten, isOnPage } = usePageBlocks()
  return useCallback(
    (value: unknown) => {
      const waitingFor = new Set<string>()
      const missing = new Set<string>()
      const unmet = computeUnmetOutputDependencies(outputDependenciesIn(value), allOutputs)
      for (const { blockId } of unmet) {
        if (isOnPage(blockId) === false) missing.add(blockId)
        else waitingFor.add(asWritten(blockId))
      }
      return { waitingFor: [...waitingFor], missing: [...missing] }
    },
    [allOutputs, asWritten, isOnPage],
  )
}
