import { useState, useEffect } from 'react'
import { useIpc } from './useIpc'
import type { UseIpcReturn } from './useIpc'
import type { GetFileReturn } from './useApiGetFile'
import { useApi } from '@/contexts/ApiContext'

/** Payload shape for the file:open-runbook event (object or legacy string). */
type OpenRunbookPayload = { path: string; remoteSource?: string } | string

function normalizePayload(data: OpenRunbookPayload): { path: string; remoteSource?: string } {
  if (typeof data === 'string') return { path: data }
  return data
}

/**
 * IPC hook to fetch the runbook file data.
 *
 * 1. On mount, fetches the CLI config to get the initial runbook path.
 *    If a remote URL was provided via CLI, the main process resolves it
 *    and sends a "file:open-runbook" event once the clone is ready.
 * 2. Listens for "file:open-runbook" events (sent by main process on CLI launch,
 *    second-instance, macOS open-file, menu, or runbook:open-remote handler).
 * 3. Passes the path to "runbook:get" IPC channel.
 */
export function useIpcGetRunbook(): UseIpcReturn<GetFileReturn> {
  const api = useApi()
  const [runbookPath, setRunbookPath] = useState<string | null>(null)
  const [remoteSource, setRemoteSource] = useState<string | undefined>(undefined)
  const [isClosed, setIsClosed] = useState(false)

  // Fetch CLI config on mount to get the initial runbook path.
  // Remote URLs are handled by the main process (index.ts) which sends
  // file:open-runbook after resolving, so we only handle local paths here.
  useEffect(() => {
    api.invoke('native:get-cli-config').then((config) => {
      if (config.runbookPath) {
        setRunbookPath(config.runbookPath)
      }
    })
  }, [api])

  // Listen for runbook open/close events from the main process
  useEffect(() => {
    const cleanupOpen = api.on('file:open-runbook', (data: OpenRunbookPayload) => {
      const payload = normalizePayload(data)
      setRunbookPath(payload.path)
      setRemoteSource(payload.remoteSource)
      setIsClosed(false)
    })
    const cleanupClose = api.on('menu:close-runbook', () => {
      setRunbookPath(null)
      setRemoteSource(undefined)
      setIsClosed(true)
    })
    return () => {
      cleanupOpen()
      cleanupClose()
    }
  }, [api])

  // Call runbook:get with the path once we have it
  const result = useIpc<GetFileReturn>(
    'runbook:get',
    runbookPath ? { path: runbookPath, remoteSource } : undefined,
    { disabled: !runbookPath }
  )

  // When closed, override stale data/error from the underlying useIpc so
  // callers see a fresh "no runbook loaded" state.
  if (isClosed) {
    return { ...result, data: null, error: null, isLoading: false }
  }
  return result
}
