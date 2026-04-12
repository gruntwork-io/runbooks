import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createAppError, type AppError } from '@/types/error'
import { useApi } from '@/contexts/ApiContext'

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

  const performInvoke = useCallback(async (invokeParams?: unknown) => {
    try {
      const result = await (api as any).invoke(channel, invokeParams)
      setData(result as T)
      setIsLoading(false)
    } catch (err: unknown) {
      setIsLoading(false)
      setError(createAppError(
        err instanceof Error ? err.message : 'An unexpected error occurred',
        err instanceof Error ? err.message : 'IPC invocation failed'
      ))
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
    if (!channel || lazy || disabled) {
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
