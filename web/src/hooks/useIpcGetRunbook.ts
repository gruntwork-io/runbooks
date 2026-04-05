import { useState, useEffect, useCallback } from 'react'
import { useIpc } from './useIpc'
import type { UseIpcReturn } from './useIpc'
import type { GetFileReturn } from './useApiGetFile'
import { useApi } from '@/contexts/ApiContext'

/**
 * IPC hook to fetch the runbook file data.
 *
 * 1. On mount, fetches the CLI config to get the initial runbook path.
 * 2. Listens for "file:open-runbook" events (sent by main process on CLI launch,
 *    second-instance, macOS open-file, or File > Open menu).
 * 3. Passes the path to "runbook:get" IPC channel.
 */
export function useIpcGetRunbook(): UseIpcReturn<GetFileReturn> {
  const api = useApi()
  const [runbookPath, setRunbookPath] = useState<string | null>(null)

  // Fetch CLI config on mount to get the initial runbook path
  useEffect(() => {
    api.invoke<{ runbookPath?: string }>('native:get-cli-config').then((config) => {
      if (config?.runbookPath) {
        setRunbookPath(config.runbookPath)
      }
    })
  }, [api])

  // Listen for "file:open-runbook" events from the main process
  useEffect(() => {
    const cleanup = api.on('file:open-runbook', (path: string) => {
      setRunbookPath(path)
    })
    return cleanup
  }, [api])

  // Call runbook:get with the path once we have it
  const result = useIpc<GetFileReturn>(
    'runbook:get',
    runbookPath ? { path: runbookPath } : undefined,
    { disabled: !runbookPath }
  )

  return result
}
