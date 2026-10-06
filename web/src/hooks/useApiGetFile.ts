import { useMemo } from "react"
import { useIpc } from "./useIpc"
import type { UseIpcReturn } from "./useIpc"
import type { SavedBlockState } from "../../../src/domain/session/history"

// API response wrapper for hooks that specifically request file data
export interface GetFileReturn {
  path: string
  content: string
  contentHash: string
  language: string
  size: number
  isWatchMode?: boolean
  warnings?: string[]
  /** The original remote URL when the runbook was opened from a remote source */
  remoteSource?: string
  /** The host of the runbook's runbook-asset:// URLs (runbook:get only) */
  assetHost?: string
  /** The session the runbook was opened in (runbook:get only) */
  sessionId?: string
  /** The name the title bar shows that session as, e.g. `elegant-elephant` (runbook:get only) */
  sessionName?: string
  /** That session's own directory, where its scripts start and its files are written (runbook:get only) */
  sessionDir?: string
  /** When that session was last used, on the load that resumed it (runbook:get only) */
  sessionResumedFrom?: string
  /** What that session's history says each block was left as (runbook:get only) */
  blockStates?: SavedBlockState[]
}

export function useGetFile(path: string, shouldFetch: boolean = true): UseIpcReturn<GetFileReturn> {
  const shouldActuallyFetch = shouldFetch && Boolean(path)

  // Build the request body with the path, memoized to prevent infinite loops
  const requestBody = useMemo(() => {
    return shouldActuallyFetch ? { path } : undefined
  }, [path, shouldActuallyFetch])

  // Use empty channel when we shouldn't fetch (prevents the IPC call)
  return useIpc<GetFileReturn>(shouldActuallyFetch ? "file:read" : "", requestBody)
}
