import { useState, useEffect, useCallback } from "react"
import { useIpc } from "./useIpc"
import type { UseIpcReturn } from "./useIpc"
import type { GetFileReturn } from "./useApiGetFile"
import { useApi } from "@/contexts/ApiContext"

/** Payload shape for the file:open-runbook event (object or legacy string). */
type OpenRunbookPayload = { path: string; remoteSource?: string } | string

function normalizePayload(data: OpenRunbookPayload): { path: string; remoteSource?: string } {
  if (typeof data === "string") return { path: data }
  return data
}

export interface UseIpcGetRunbookReturn extends UseIpcReturn<GetFileReturn> {
  /**
   * Open a runbook by path. Every call is a new request, even for the path
   * that is already current, so re-picking a folder after fixing it re-reads it.
   */
  openRunbook: (path: string, remoteSource?: string) => void
  /**
   * Reload after a watch-mode change. Without a path, silently re-sends the
   * current request; with one, makes that runbook (the displayed one, after a
   * failed open) the current request, so later reloads re-send it too.
   */
  reloadForWatch: (path?: string, remoteSource?: string) => void
}

/**
 * IPC hook to fetch the runbook file data.
 *
 * 1. On mount, fetches the CLI config to get the initial runbook path: the
 *    local path on the command line or, with none, the runbook of the session
 *    the launch resumes. If that runbook is remote, the main process clones
 *    it and sends a "file:open-runbook" event once the clone is ready.
 * 2. Listens for "file:open-runbook" events (sent by main process for a remote
 *    runbook at launch, second-instance, macOS open-file, the Open
 *    menu/dialog, and Reset Session).
 * 3. Exposes `openRunbook` for opens the renderer decides on itself: the
 *    Open from URL modal calls it with the path `runbook:open-remote` returns,
 *    so a cancelled clone never replaces the current runbook.
 * 4. Passes the path to "runbook:get" IPC channel.
 */
export function useIpcGetRunbook(): UseIpcGetRunbookReturn {
  const api = useApi()
  const [runbookPath, setRunbookPath] = useState<string | null>(null)
  const [remoteSource, setRemoteSource] = useState<string | undefined>(undefined)
  // Bumped on every open so a repeat open of the current path still changes
  // the useIpc params (and so fetches again). runbook:get ignores the field.
  // A same-path open is therefore a reload: block state here is kept, unless
  // main answers with a new sessionId, as it does for Reset Session.
  const [openNonce, setOpenNonce] = useState(0)
  const [isClosed, setIsClosed] = useState(false)

  const openRunbook = useCallback((path: string, source?: string) => {
    setRunbookPath(path)
    setRemoteSource(source)
    setOpenNonce((n) => n + 1)
    setIsClosed(false)
  }, [])

  // Fetch CLI config on mount to get the initial runbook path. Main sends no
  // file:open-runbook for it, which would load the runbook twice. Remote URLs
  // are handled by the main process (index.ts) which sends file:open-runbook
  // after resolving, so we only handle local paths here.
  useEffect(() => {
    api
      .invoke("native:get-cli-config")
      .then((config) => {
        if (config.runbookPath) {
          setRunbookPath(config.runbookPath)
        }
      })
      .catch((err: unknown) => {
        console.error("Failed to read the CLI config:", err)
      })
  }, [api])

  // Listen for runbook open/close events from the main process
  useEffect(() => {
    const cleanupOpen = api.on("file:open-runbook", (data: OpenRunbookPayload) => {
      const payload = normalizePayload(data)
      openRunbook(payload.path, payload.remoteSource)
    })
    const cleanupClose = api.on("menu:close-runbook", () => {
      setRunbookPath(null)
      setRemoteSource(undefined)
      setIsClosed(true)
    })
    return () => {
      cleanupOpen()
      cleanupClose()
    }
  }, [api, openRunbook])

  // Call runbook:get with the path once we have it
  const result = useIpc<GetFileReturn>(
    "runbook:get",
    runbookPath ? { path: runbookPath, remoteSource, openNonce } : undefined,
    { disabled: !runbookPath },
  )

  const { silentRefetch } = result
  const reloadForWatch = useCallback(
    (path?: string, source?: string) => {
      if (path === undefined) {
        silentRefetch()
      } else {
        openRunbook(path, source)
      }
    },
    [silentRefetch, openRunbook],
  )

  // When closed, override stale data/error from the underlying useIpc so
  // callers see a fresh "no runbook loaded" state.
  if (isClosed) {
    return { ...result, data: null, error: null, isLoading: false, openRunbook, reloadForWatch }
  }
  return { ...result, openRunbook, reloadForWatch }
}
