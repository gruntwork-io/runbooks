import { useCallback, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { normalizeBlockId } from "@/lib/utils"
import {
  BlockRunsContext,
  type BlockRun,
  type BlockRunHandlers,
  type BlockRunsContextType,
} from "./BlockRunsContext.types"

/**
 * Tracks the run status of every Command and Check block, so a block can tell
 * whether a block it must wait for is running or has succeeded, and can stop
 * or scroll to that block.
 */
export function BlockRunsProvider({ children }: { children?: ReactNode }) {
  const [runs, setRuns] = useState<Record<string, BlockRun>>({})
  const handlersRef = useRef(new Map<string, BlockRunHandlers>())

  const registerBlock = useCallback((blockId: string, handlers: BlockRunHandlers) => {
    const key = normalizeBlockId(blockId)
    handlersRef.current.set(key, handlers)
    return () => {
      handlersRef.current.delete(key)
      setRuns((prev) => {
        const { [key]: _removed, ...rest } = prev
        return rest
      })
    }
  }, [])

  const reportRun = useCallback((run: BlockRun) => {
    const key = normalizeBlockId(run.blockId)
    setRuns((prev) => {
      const current = prev[key]
      const unchanged =
        current !== undefined &&
        current.blockId === run.blockId &&
        current.status === run.status &&
        current.exclusive === run.exclusive
      return unchanged ? prev : { ...prev, [key]: run }
    })
  }, [])

  const stopRun = useCallback((blockId: string) => {
    handlersRef.current.get(normalizeBlockId(blockId))?.stop()
  }, [])

  const revealBlock = useCallback((blockId: string) => {
    handlersRef.current.get(normalizeBlockId(blockId))?.reveal()
  }, [])

  const value = useMemo(
    (): BlockRunsContextType => ({ runs, registerBlock, reportRun, stopRun, revealBlock }),
    [runs, registerBlock, reportRun, stopRun, revealBlock],
  )

  return <BlockRunsContext.Provider value={value}>{children}</BlockRunsContext.Provider>
}
