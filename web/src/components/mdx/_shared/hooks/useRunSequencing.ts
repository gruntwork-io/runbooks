import { useEffect, useMemo, useRef } from "react"
import { useBlockRuns } from "@/contexts/useBlockRuns"
import type { BlockRunStatus } from "@/contexts/BlockRunsContext.types"
import { computeRunBlockers, type RunBlockers } from "@/lib/blockRuns"

interface UseRunSequencingProps {
  blockId: string
  status: BlockRunStatus
  exclusive: boolean
  dependsOn: string | string[] | undefined
  /** Ids of the blocks whose outputs this block's script references. */
  outputDependencyIds: readonly string[]
  /** Stops this block's running script. */
  stop: () => void
  /** Scrolls this block into view. */
  reveal: () => void
}

interface UseRunSequencingReturn {
  blockers: RunBlockers
  stopRun: (blockId: string) => void
  revealBlock: (blockId: string) => void
}

/**
 * Publishes a Command or Check block's run status to the other blocks, and
 * returns what in their status stops this block from running.
 */
export function useRunSequencing({
  blockId,
  status,
  exclusive,
  dependsOn,
  outputDependencyIds,
  stop,
  reveal,
}: UseRunSequencingProps): UseRunSequencingReturn {
  const { runs, registerBlock, reportRun, stopRun, revealBlock } = useBlockRuns()

  const handlersRef = useRef({ stop, reveal })
  useEffect(() => {
    handlersRef.current = { stop, reveal }
  }, [stop, reveal])

  useEffect(() => {
    if (!blockId) return
    return registerBlock(blockId, {
      stop: () => handlersRef.current.stop(),
      reveal: () => handlersRef.current.reveal(),
    })
  }, [blockId, registerBlock])

  useEffect(() => {
    if (!blockId) return
    reportRun({ blockId, status, exclusive })
  }, [blockId, status, exclusive, reportRun])

  // Keyed on the ids, since an array literal in MDX is a new array on every render.
  const dependsOnKey = JSON.stringify([dependsOn ?? []].flat())
  const dependsOnIds = useMemo(() => JSON.parse(dependsOnKey) as string[], [dependsOnKey])

  const blockers = useMemo(
    () =>
      computeRunBlockers({
        blockId,
        exclusive,
        outputDependencyIds,
        dependsOn: dependsOnIds,
        runs,
      }),
    [blockId, exclusive, outputDependencyIds, dependsOnIds, runs],
  )

  return { blockers, stopRun, revealBlock }
}
