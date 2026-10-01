import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react"
import { createAppError, type AppError } from "@/types/error"
import { useApi } from "@/contexts/ApiContext"
import { markStage, getPerfPayload } from "@/lib/renderPerf"
import { cleanIpcErrorMessage } from "@/lib/ipcError"

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
  silentRefetch: (extraParams?: Record<string, unknown>) => void
}

/**
 * Base IPC hook that replaces useApi for Electron.
 * Invokes an IPC channel with optional params, returning data/loading/error state.
 */
export function useIpc<T>(
  channel: string,
  params?: unknown,
  options?: UseIpcOptions,
): UseIpcReturn<T> {
  const api = useApi()
  const { lazy = false, debounceMs, disabled = false } = options || {}

  const active = Boolean(channel) && !disabled
  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(active && !lazy)
  const [error, setError] = useState<AppError | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // False once the hook unmounts, so a pending debounced request is dropped
  // when its timer fires. See the unmount effect below. It starts true so a
  // request scheduled before passive effects run (from a layout effect, say)
  // isn't dropped if its timer fires first.
  const mountedRef = useRef(true)

  // Use a ref for params so changing object identity doesn't trigger re-fetches.
  // Content changes are detected via paramsKey below.
  const paramsRef = useRef(params)
  useLayoutEffect(() => {
    paramsRef.current = params
  })
  const paramsKey = JSON.stringify(params)

  // Reset state during render whenever the fetch inputs change, so the
  // first render with new inputs already shows the matching state.
  const [prevInputs, setPrevInputs] = useState({ channel, paramsKey, lazy, disabled })
  if (
    prevInputs.channel !== channel ||
    prevInputs.paramsKey !== paramsKey ||
    prevInputs.lazy !== lazy ||
    prevInputs.disabled !== disabled
  ) {
    setPrevInputs({ channel, paramsKey, lazy, disabled })
    if (!active) {
      // Cleared or disabled: the previous file/config shouldn't linger when
      // nothing is selected.
      setData(null)
      setError(null)
      setIsLoading(false)
    } else if (lazy) {
      // Lazy: keep any existing data; the consumer drives fetches via refetch.
      setIsLoading(false)
    } else {
      setIsLoading(true)
      setError(null)
    }
  }

  // Monotonic request counter. We only commit a response if it's still the
  // latest request — this prevents a slow earlier call from overwriting a
  // newer one (stale-closure race) and lets render handlers signal a
  // superseded result the main process interrupted.
  const requestSeqRef = useRef(0)

  const performInvoke = useCallback(
    async (invokeParams?: unknown) => {
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
        perf && invokeParams && typeof invokeParams === "object"
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
          typeof result === "object" &&
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
        const message =
          err instanceof Error ? cleanIpcErrorMessage(err.message) : "An unexpected error occurred"
        setError(createAppError(message, message))
        setIsLoading(false)
      }
    },
    [api, channel],
  )

  // Debounced request function
  const debouncedRequest = useCallback(
    (newParams?: unknown) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }

      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        if (!mountedRef.current) return
        setIsLoading(true)
        setError(null)
        void performInvoke(newParams)
      }, debounceMs || 0)
    },
    [debounceMs, performInvoke],
  )

  // Refetch - immediately re-invokes with the current params
  const refetch = useCallback(() => {
    setIsLoading(true)
    setError(null)
    void performInvoke(paramsRef.current)
  }, [performInvoke])

  // Silent refetch - re-invokes without showing loading state. `extraParams`
  // are added to the current params for this one request.
  const silentRefetch = useCallback(
    (extraParams?: Record<string, unknown>) => {
      setError(null)
      const current = paramsRef.current
      void performInvoke(
        extraParams && current && typeof current === "object"
          ? { ...current, ...extraParams }
          : current,
      )
    },
    [performInvoke],
  )

  useEffect(() => {
    if (!active) {
      // Drop any in-flight response. A pending debounced request must be
      // cancelled outright: its timer would call the performInvoke captured at
      // scheduling time (still holding the old channel) and take a fresh seq,
      // so bumping the seq can't stop it.
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      requestSeqRef.current += 1
      return
    }

    if (lazy) return

    void performInvoke(paramsRef.current)

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [active, performInvoke, paramsKey, lazy])

  // Stop a pending debounced request from being sent after unmount, in every
  // mode. The effect above has no cleanup in lazy mode, which is the mode
  // that schedules debounced requests.
  //
  // The cleanup only flips a flag that the timer checks. It doesn't clear the
  // timer or bump requestSeqRef, because StrictMode (in dev) and Fast Refresh
  // run this cleanup and then the setup again on a live component. The setup
  // restores the flag, but it can't reschedule a timer or re-send a request
  // that a consumer issued once from its own mount effect. A real unmount
  // needs no invalidation, since React ignores setState on an unmounted
  // component.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  return { data, isLoading, error, debouncedRequest, refetch, silentRefetch }
}
