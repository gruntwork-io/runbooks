import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"

export interface CommitsAheadState {
  /** Commits HEAD has that the base branch lacks; null until known or when the query fails. */
  count: number | null
  /** Query again and resolve with the fresh count (null on failure or with no worktree). */
  refresh: () => Promise<number | null>
}

/**
 * Commits the cloned repo's HEAD has that `baseBranch` doesn't: what a PR/MR
 * opened from HEAD carries besides uncommitted changes. Measured in the main
 * process against origin's copy of the base, as the create itself measures it.
 * Queried again whenever `refreshKey` changes (e.g. after a script ran).
 */
export function useCommitsAhead(
  localPath: string | undefined,
  baseBranch: string | undefined,
  refreshKey: unknown,
): CommitsAheadState {
  const api = useApi()
  const [count, setCount] = useState<number | null>(null)
  // Responses can arrive out of order; only the latest query's may land.
  const genRef = useRef(0)

  const query = useCallback(async (): Promise<number | null> => {
    if (!localPath || !baseBranch) return null
    try {
      return (await api.invoke("git:commits-ahead", { worktreePath: localPath, baseBranch })).count
    } catch {
      return null
    }
  }, [api, localPath, baseBranch])

  const refresh = useCallback(async (): Promise<number | null> => {
    const gen = ++genRef.current
    const next = await query()
    if (gen === genRef.current) setCount(next)
    return next
  }, [query])

  useEffect(() => {
    const gen = ++genRef.current
    void query().then((next) => {
      if (gen === genRef.current) setCount(next)
    })
  }, [query, refreshKey])

  return { count: localPath && baseBranch ? count : null, refresh }
}
