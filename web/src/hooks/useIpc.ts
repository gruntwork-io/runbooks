import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createAppError, type AppError } from '@/types/error'
import { useApi } from '@/contexts/ApiContext'
import { markStage, getPerfPayload } from '@/lib/renderPerf'

export interface UseIpcOptions {
  /** When true, skip the initial auto-fetch. Requests are only made via refetch. */
  lazy?: boolean
  /** Debounce delay in milliseconds for the debouncedRequest function. */
  debounceMs?: number
  /** When true, disable fetching entirely. */
  disabled?: boolean
}

export interface UseIpcReturn<T> {
  data: T | null
  isLoading: boolean
  error: AppError | null
  debouncedRequest?: (newParams?: unknown) => void
  refetch: () => void
  silentRefetch: () => void
}

/**
 * Strip Electron's IPC wrapper from a rejected invoke message so the renderer
 * can show the handler's actual message. Electron rejects with
 * "Error invoking remote method 'channel': Error: <message>"; we want just
 * "<message>".
 */
function cleanIpcErrorMessage(raw: string): string {
  let msg = raw.replace(/^Error invoking remote method '[^']*':\s*/, '')
  // Serialization can leave one or more leading "Error: " prefixes.
  while (/^Error:\s*/.test(msg)) {
    msg = msg.replace(/^Error:\s*/, '')
  }
  return msg.trim()
}

/**
 * Base IPC hook that replaces useApi for Electron.
 * Invokes an IPC channel with optional params, returning data/loading/error state.
 */
export function useIpc<T>(
  channel: string,
  params?: unknown,
  options?: UseIpcOptions
): UseIpcReturn<T> {
  const api = useApi()
  const { lazy = false, debounceMs, disabled = false } = options || {}

  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(!lazy && !disabled)
  const [error, setError] = useState<AppError | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Use a ref for params so changing object identity doesn't trigger re-fetches.
  // Content changes are detected via paramsKey below.
  const paramsRef = useRef(params)
  paramsRef.current = params
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const paramsKey = useMemo(() => JSON.stringify(params), [JSON.stringify(params)])

  // Monotonic request counter. We only commit a response if it's still the
  // latest request — this prevents a slow earlier call from overwriting a
  // newer one (stale-closure race) and lets render handlers signal a
  // superseded result the main process interrupted.
  const requestSeqRef = useRef(0)

  const performInvoke = useCallback(async (invokeParams?: unknown) => {
    if (!channel) {
      // No channel: invalidate any in-flight request and clear stale state so a
      // cleared/disabled hook never commits or keeps showing the prior result.
      requestSeqRef.current += 1
      setData(null)
      setError(null)
      setIsLoading(false)
      return
    }
    const seq = ++requestSeqRef.current
    // Attach the perf payload (when tracing is enabled) so the main process can
    // correlate its timing logs with the renderer keystroke trace. It's an
    // inert extra field for channels that don't read it.
    const perf = getPerfPayload()
    const finalParams =
      perf && invokeParams && typeof invokeParams === 'object'
        ? { ...invokeParams, perf }
        : invokeParams
    markStage(`useIpc:ipc-send ${channel}`, { ipcSeq: seq })
    try {
      const result = await (api as any).invoke(channel, finalParams)
      markStage(`useIpc:ipc-response ${channel}`, { ipcSeq: seq })
      // Superseded: the main process interrupted this call because a newer one
      // arrived. Leave state alone — the newer call will drive it.
      if (
        result &&
        typeof result === 'object' &&
        (result as { superseded?: boolean }).superseded
      ) {
        return
      }
      if (seq !== requestSeqRef.current) return
      setData(result as T)
      setError(null)
      setIsLoading(false)
    } catch (err: unknown) {
      if (seq !== requestSeqRef.current) return
      const message = err instanceof Error
        ? cleanIpcErrorMessage(err.message)
        : 'An unexpected error occurred'
      setError(createAppError(message, message))
      setIsLoading(false)
    }
  }, [api, channel])

  // Debounced request function
  const debouncedRequest = useCallback((newParams?: unknown) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    timeoutRef.current = setTimeout(async () => {
      setIsLoading(true)
      setError(null)
      await performInvoke(newParams)
    }, debounceMs || 0)
  }, [debounceMs, performInvoke])

  // Refetch - immediately re-invokes with the current params
  const refetch = useCallback(() => {
    setIsLoading(true)
    setError(null)
    performInvoke(paramsRef.current)
  }, [performInvoke])

  // Silent refetch - re-invokes without showing loading state
  const silentRefetch = useCallback(() => {
    setError(null)
    performInvoke(paramsRef.current)
  }, [performInvoke])

  useEffect(() => {
    if (!channel || disabled) {
      // Cleared or disabled: drop any in-flight response and stale data so the
      // previous file/config doesn't linger when nothing is selected.
      requestSeqRef.current += 1
      setData(null)
      setError(null)
      setIsLoading(false)
      return
    }

    // Lazy: keep any existing data; the consumer drives fetches via refetch.
    if (lazy) {
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)
    performInvoke(paramsRef.current)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [channel, performInvoke, paramsKey, lazy, disabled])

  return { data, isLoading, error, debouncedRequest, refetch, silentRefetch }
}
