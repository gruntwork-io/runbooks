import { useContext } from "react"
import { RunbookLayoutContext } from "./RunbookLayoutContext.types"

export function useRunbookLayout() {
  const context = useContext(RunbookLayoutContext)
  if (context === undefined) {
    throw new Error("useRunbookLayout must be used within a RunbookLayoutProvider")
  }
  return context
}
