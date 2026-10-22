import { useContext } from "react"
import { BlockRunsContext, type BlockRunsContextType } from "./BlockRunsContext.types"

export function useBlockRuns(): BlockRunsContextType {
  const context = useContext(BlockRunsContext)
  if (context === undefined) {
    throw new Error("useBlockRuns must be used within a BlockRunsProvider")
  }
  return context
}
