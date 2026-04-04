import { useEffect } from 'react'
import { useApi } from '@/contexts/ApiContext'

/**
 * IPC hook to enable watch mode - listens for file changes via IPC events.
 * Replaces useWatchMode which used SSE via EventSource.
 */
export function useIpcWatchMode(onFileChange: () => void, isWatchMode: boolean = false) {
  const api = useApi()

  useEffect(() => {
    if (!isWatchMode) {
      return
    }

    // Subscribe to file change events from the Electron main process
    const unsubscribe = api.on('watch:file-change', () => {
      onFileChange()
    })

    // Cleanup on unmount
    return () => {
      unsubscribe()
    }
  }, [api, onFileChange, isWatchMode])
}
