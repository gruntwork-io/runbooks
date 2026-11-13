import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react"
import type { RunbooksAPI } from "./ApiContext"
import type {
  GitFileChangesContextType,
  WorkspaceFileChange,
} from "./WorkspaceGitDataContext.types"

interface WorkspaceChangesResponse {
  changes: WorkspaceFileChange[]
  totalChanges: number
  tooManyChanges?: boolean
}

const POLL_INTERVAL_MS = 3000

/**
 * Polls for git changes in the worktree at `localPath` every 3 seconds, and refetches
 * when the worktree switches or treeVersion bumps: immediately, or as soon as
 * the one poll allowed in flight settles.
 */
export function useChangesPoller(
  api: RunbooksAPI,
  localPath: string | null,
  treeVersion: number,
): GitFileChangesContextType {
  const [changes, setChanges] = useState<WorkspaceFileChange[]>([])
  const [totalChanges, setTotalChanges] = useState(0)
  const [tooManyChanges, setTooManyChanges] = useState(false)
  const [isLoading, setIsLoading] = useState(localPath !== null)
  // Bumped on every run of the poll (worktree switch or tree invalidation).
  // IPC calls can't be cancelled, so a response that belongs to an earlier run
  // is dropped rather than committed over the current state.
  const genRef = useRef(0)
  // The current run's worktree, or null when there is nothing to poll.
  const runPathRef = useRef<string | null>(null)
  // Generation whose request is in flight; only one poll runs at a time.
  // Interval ticks skip while their own run's request is outstanding. A newer
  // run's fetch that finds an older run's request still pending sets
  // `followUpRef` instead, and exactly one fetch for the latest run starts when
  // that request settles, however many runs started in the meantime.
  const inFlightGenRef = useRef<number | null>(null)
  const followUpRef = useRef(false)
  const previousResponseRef = useRef<string>("")

  // A new run starts when the worktree or treeVersion changes: show the spinner
  // until its first poll settles or, with no worktree left to poll, drop the
  // previous one's changes. Done during render; the generation bump below
  // drops the previous run's in-flight response.
  const [run, setRun] = useState({ path: localPath, treeVersion })
  if (run.path !== localPath || run.treeVersion !== treeVersion) {
    setRun({ path: localPath, treeVersion })
    if (localPath) {
      setIsLoading(true)
    } else {
      setChanges([])
      setTotalChanges(0)
      setTooManyChanges(false)
      setIsLoading(false)
    }
  }

  const fetchChanges = useCallback(
    async function poll(path: string, gen: number): Promise<void> {
      if (inFlightGenRef.current !== null) {
        if (inFlightGenRef.current !== gen) followUpRef.current = true
        return
      }
      inFlightGenRef.current = gen

      try {
        const data = (await api.invoke("workspace:changes", {
          worktreePath: path,
        })) as unknown as WorkspaceChangesResponse
        if (gen !== genRef.current) return // Superseded by a worktree switch or tree invalidation

        // Smart skipping: don't update state if response is identical
        const text = JSON.stringify(data)
        if (text === previousResponseRef.current) {
          return
        }
        previousResponseRef.current = text
        setChanges(data.changes || [])
        setTotalChanges(data.totalChanges)
        setTooManyChanges(data.tooManyChanges ?? false)
      } catch {
        // Silently retry on next interval
      } finally {
        inFlightGenRef.current = null
        // A superseded request must not clear the spinner of the run that replaced it
        if (gen === genRef.current) setIsLoading(false)
        if (followUpRef.current) {
          followUpRef.current = false
          const latestPath = runPathRef.current
          if (latestPath) void poll(latestPath, genRef.current)
        }
      }
    },
    [api],
  )

  // Start the run's generation in the commit that renders it. A layout effect
  // runs in the same task as that render, so no earlier run's response can
  // land in between and clear the spinner set above.
  useLayoutEffect(() => {
    genRef.current++
    runPathRef.current = localPath
    // Clear cache so the next fetch isn't skipped by smart-dedup
    previousResponseRef.current = ""
    return () => {
      runPathRef.current = null
    }
  }, [localPath, fetchChanges, treeVersion])

  // Poll for changes, and refetch when the worktree or treeVersion changes
  useEffect(() => {
    if (!localPath) return
    const gen = genRef.current

    // Fetch on mount / worktree change / tree invalidation: now, or once the
    // request still running for an earlier run settles
    void fetchChanges(localPath, gen)

    const interval = setInterval(() => {
      void fetchChanges(localPath, gen)
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [localPath, fetchChanges, treeVersion])

  const fetchFileDiff = useCallback(
    async (filePath: string) => {
      if (!localPath) return
      const gen = genRef.current

      try {
        const data = (await api.invoke("workspace:changes", {
          worktreePath: localPath,
          singleFile: filePath,
        })) as unknown as WorkspaceChangesResponse
        // The worktree switched or its files changed while the diff loaded; the
        // next poll has already replaced (or will replace) this entry.
        if (gen !== genRef.current) return
        const fullChange = data.changes?.[0]
        if (fullChange) {
          // Merge the full diff into the existing changes array
          setChanges((prev) =>
            prev.map((c) =>
              c.path === filePath
                ? {
                    ...c,
                    originalContent: fullChange.originalContent,
                    newContent: fullChange.newContent,
                    diffTruncated: false,
                  }
                : c,
            ),
          )
        }
      } catch {
        // Silently fail
      }
    },
    [api, localPath],
  )

  return useMemo(
    () => ({ changes, totalChanges, tooManyChanges, isLoading, fetchFileDiff }),
    [changes, totalChanges, tooManyChanges, isLoading, fetchFileDiff],
  )
}
