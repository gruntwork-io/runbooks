import { createContext } from "react"

/** Where a Command or Check block's latest run stands. */
export type BlockRunStatus = "pending" | "running" | "success" | "warn" | "fail"

export interface BlockRun {
  /** The block's id as the author wrote it, for display. */
  blockId: string
  status: BlockRunStatus
  /** Whether the author marked the block `exclusive`. */
  exclusive: boolean
}

/** What one block lets the others do to it. */
export interface BlockRunHandlers {
  /** Stops the block's running script. */
  stop: () => void
  /** Scrolls the block into view. */
  reveal: () => void
}

export interface BlockRunsContextType {
  /** Every mounted Command and Check block, keyed by normalized block id. */
  runs: Record<string, BlockRun>
  /** Adds a block. Returns the function that removes it. */
  registerBlock: (blockId: string, handlers: BlockRunHandlers) => () => void
  /** Records a block's status. */
  reportRun: (run: BlockRun) => void
  stopRun: (blockId: string) => void
  revealBlock: (blockId: string) => void
}

export const BlockRunsContext = createContext<BlockRunsContextType | undefined>(undefined)
