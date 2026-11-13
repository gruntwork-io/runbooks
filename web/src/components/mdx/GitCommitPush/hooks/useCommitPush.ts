import { useCallback, useEffect, useRef, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { LogEntry } from "@/hooks/useApiExec"
import type { IpcChannelMap } from "../../../../../../electron/shared/channels"

export type CommitPushRequest = IpcChannelMap["git:push"]["params"]

/** What the last successful push did. */
export interface Pushed {
  readonly branch: string
  readonly commitSha?: string | undefined
  /** Whether it made a new commit, as opposed to pushing ones already made. */
  readonly committed: boolean
}

export interface CommitPush {
  readonly running: boolean
  readonly logs: LogEntry[]
  readonly pushed: Pushed | undefined
  readonly error: string | undefined
  /** Resolves with what was pushed, or undefined when it failed. */
  readonly run: (request: CommitPushRequest) => Promise<Pushed | undefined>
}

/** Commits and pushes a clone's changes, keeping the log of the last run. */
export function useCommitPush(): CommitPush {
  const api = useApi()
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [pushed, setPushed] = useState<Pushed>()
  const [error, setError] = useState<string>()
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const run = useCallback(
    async (request: CommitPushRequest) => {
      setRunning(true)
      setError(undefined)
      setLogs([])
      // The log lines of this push, which runs alone while the block waits on it.
      const unsubscribe = api.on("git:log", ({ line, timestamp }) => {
        if (mounted.current) setLogs((prev) => [...prev, { line, timestamp }])
      })
      try {
        const result = await api.invoke("git:push", request)
        if (!mounted.current) return undefined
        if ("error" in result) {
          setError(result.error)
          return undefined
        }
        const next: Pushed = {
          branch: result.branch,
          commitSha: result.commitSha,
          committed: result.committed,
        }
        setPushed(next)
        return next
      } catch (err) {
        if (mounted.current) {
          setError(cleanIpcErrorMessage(err instanceof Error ? err.message : String(err)))
        }
        return undefined
      } finally {
        unsubscribe()
        if (mounted.current) setRunning(false)
      }
    },
    [api],
  )

  return { running, logs, pushed, error, run }
}
