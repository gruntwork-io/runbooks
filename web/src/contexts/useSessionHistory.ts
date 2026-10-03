import { useContext } from "react"
import { SessionHistoryContext, type SessionHistory } from "./SessionHistoryContext.types"

/**
 * Hook for a block to read what the session's history says it was left as,
 * and to add what the user does to it.
 */
export function useSessionHistory(): SessionHistory {
  return useContext(SessionHistoryContext)
}
