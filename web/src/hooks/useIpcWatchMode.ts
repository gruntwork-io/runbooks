import { useEffect, useEffectEvent } from "react"
import { useApi } from "@/contexts/ApiContext"
import type { IpcEventMap } from "../../../electron/shared/channels.ts"

/** The open runbook was written on disk: its path and the hash of what is there now. */
export type RunbookFileChange = IpcEventMap["watch:file-change"]

/**
 * IPC hook for changes to the open runbook's file - calls `onFileChange`
 * whenever the main process reports that the runbook it watches was written
 * on disk. Main watches the open runbook with or without --watch; the caller
 * decides whether to reload at once or to offer the reload. The main process
 * owns the file watcher; this only listens for its events.
 */
export function useIpcWatchMode(onFileChange: (change: RunbookFileChange) => void) {
  const api = useApi()

  // An effect event so a new callback identity on each render doesn't tear
  // down and re-register the listener.
  const handleFileChange = useEffectEvent((change: RunbookFileChange) => {
    onFileChange(change)
  })

  useEffect(() => {
    // Subscribe to file change events from the Electron main process
    const unsubscribe = api.on("watch:file-change", (change) => {
      handleFileChange(change)
    })

    // Cleanup on unmount
    return () => {
      unsubscribe()
    }
  }, [api])
}
