import { useCallback, useEffect, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { GitHubPrRef } from "../../../../../../electron/shared/channels"
import type { MergeState } from "../../../../../../src/domain/git/merge"

/** How often an open pull request's merge state is asked for again, as reviews and checks land. */
const RECHECK_MS = 15_000

const message = (err: unknown) =>
  cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))

export interface PrMerge {
  /** What GitHub says now; undefined until it answers. */
  readonly state: MergeState | undefined
  /** Why asking GitHub failed. */
  readonly checkError: string | undefined
  readonly merging: boolean
  readonly mergeError: string | undefined
  readonly refresh: () => void
  readonly merge: () => void
}

/**
 * Whether the block's pull request can merge, asked of GitHub while `pr` is
 * set and again every so often while it's open, and merging it.
 */
export function usePrMerge(pr: GitHubPrRef | undefined): PrMerge {
  const api = useApi()
  const [state, setState] = useState<MergeState>()
  const [checkError, setCheckError] = useState<string>()
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const key = pr ? JSON.stringify(pr) : undefined

  // Another pull request starts from knowing nothing about it.
  const [askedFor, setAskedFor] = useState(key)
  if (askedFor !== key) {
    setAskedFor(key)
    setState(undefined)
    setCheckError(undefined)
    setMergeError(undefined)
  }

  // Nothing changes once it's merged or closed, so asking stops then.
  const settled = state !== undefined && state.state !== "open"

  useEffect(() => {
    if (!key || settled) return
    let cancelled = false
    const ask = () =>
      api
        .invoke("git:pr-merge-state", JSON.parse(key) as GitHubPrRef)
        .then((next) => {
          if (cancelled) return
          setState(next)
          setCheckError(undefined)
        })
        .catch((err: unknown) => {
          if (!cancelled) setCheckError(message(err))
        })
    void ask()
    const timer = setInterval(() => void ask(), RECHECK_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [api, key, settled, attempt])

  const refresh = useCallback(() => setAttempt((n) => n + 1), [])

  // The head GitHub said was ready, so a merge never takes commits the user hasn't seen.
  const readyHead =
    state?.state === "open" && state.mergeability === "ready" ? state.headSha : undefined

  const merge = useCallback(() => {
    if (!key || !readyHead) return
    setMerging(true)
    setMergeError(undefined)
    api
      .invoke("git:pr-merge", { ...(JSON.parse(key) as GitHubPrRef), headSha: readyHead })
      .then(({ sha }) => setState(sha ? { state: "merged", sha } : { state: "merged" }))
      .catch((err: unknown) => {
        setMergeError(message(err))
        setAttempt((n) => n + 1)
      })
      .finally(() => setMerging(false))
  }, [api, key, readyHead])

  return { state, checkError, merging, mergeError, refresh, merge }
}
