import { useContext } from "react"
import { RunbookProgressContext, type RunbookProgress } from "./RunbookProgressContext.types"

/** How many of the open runbook's steps there are, and how many are done. */
export function useRunbookProgress(): RunbookProgress {
  return useContext(RunbookProgressContext)
}
