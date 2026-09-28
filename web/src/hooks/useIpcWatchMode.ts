import { useEffect, useRef } from 'react'
import { useApi } from '@/contexts/ApiContext'

/**
 * IPC hook for watch mode - calls `onFileChange` with the watched runbook's
 * path whenever the main process reports that it changed on disk. The main
 * process owns the file watcher; this only listens for its events.
 */
export function useIpcWatchMode(onFileChange: (runbookPath: string) => void, isWatchMode: boolean = false) {
  const api = useApi()

  // Keep the latest callback in a ref so a new function identity on each
  // render doesn't tear down and re-register the listener.
  const onFileChangeRef = useRef(onFileChange)
  onFileChangeRef.current = onFileChange

  useEffect(() => {
    if (!isWatchMode) {
      return
    }

    // Subscribe to file change events from the Electron main process
    const unsubscribe = api.on('watch:file-change', (change) => {
      onFileChangeRef.current(change.path)
    })

    // Cleanup on unmount
    return () => {
      unsubscribe()
    }
  }, [api, isWatchMode])
}
