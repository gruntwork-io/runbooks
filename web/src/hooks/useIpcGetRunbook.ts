import { useState, useEffect, useCallback } from 'react'
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
 * 2. Listens for "file:open-runbook" events (sent by main process on CLI launch,
 *    second-instance, macOS open-file, or File > Open menu).
 * 3. Passes the path to "runbook:get" IPC channel.
 */
export function useIpcGetRunbook(): UseIpcReturn<GetFileReturn> {
  const api = useApi()
  const [runbookPath, setRunbookPath] = useState<string | null>(null)
  const [remoteSource, setRemoteSource] = useState<string | undefined>(undefined)

  // Fetch CLI config on mount to get the initial runbook path or remote URL
  useEffect(() => {
    api.invoke<{ runbookPath?: string; remoteUrl?: string }>('native:get-cli-config').then((config) => {
      if (config?.remoteUrl) {
        // Remote URL — trigger resolution via IPC, the main process will
        // send file:open-runbook once resolved.
        api.invoke('runbook:open-remote', { url: config.remoteUrl }).catch((err: unknown) => {
          console.error('[useIpcGetRunbook] Failed to open remote URL:', err)
        })
      } else if (config?.runbookPath) {
        setRunbookPath(config.runbookPath)
      }
    })
  }, [api])

  // Listen for "file:open-runbook" events from the main process
  useEffect(() => {
    const cleanup = api.on('file:open-runbook', (data: OpenRunbookPayload) => {
      const payload = normalizePayload(data)
      setRunbookPath(payload.path)
      setRemoteSource(payload.remoteSource)
    })
    return cleanup
  }, [api])

  // Call runbook:get with the path once we have it
  const result = useIpc<GetFileReturn>(
    'runbook:get',
    runbookPath ? { path: runbookPath, remoteSource } : undefined,
    { disabled: !runbookPath }
  )

  return result
}
