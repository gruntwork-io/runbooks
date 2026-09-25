import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { ApiProvider, type RunbooksAPI } from '@/contexts/ApiContext'
import { useIpc, type UseIpcOptions } from './useIpc'

// =============================================================================
// useIpc request sequencing, lazy/debounce and disabled transitions
// =============================================================================
//
// Mock boundary: the IPC `invoke` is the only fake. It returns a promise the
// test settles by hand, so response ordering is under the test's control.
// `useApi()` is fed through the real ApiProvider.

interface PendingInvoke {
  channel: string
  params: unknown
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

function createControllableApi() {
  const pending: PendingInvoke[] = []
  const invoke = vi.fn(
    (channel: string, params?: unknown) =>
      new Promise((resolve, reject) => {
        pending.push({ channel, params, resolve, reject })
      })
  )
  const api = { invoke, on: () => () => {}, once: () => {} } as unknown as RunbooksAPI
  return { api, invoke, pending }
}

interface HookProps {
  channel: string
  params?: unknown
  options?: UseIpcOptions
}

function renderUseIpc(api: RunbooksAPI, initialProps: HookProps) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ApiProvider, { api, children })
  return renderHook(
    ({ channel, params, options }: HookProps) => useIpc<unknown>(channel, params, options),
    { initialProps, wrapper }
  )
}

/** Settle an invoke and let the hook's await continuation run inside act. */
async function settle(fn: () => void) {
  await act(async () => {
    fn()
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useIpc', () => {
  describe('eager fetch', () => {
    it('fetches on mount and commits the response', async () => {
      const { api, invoke, pending } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith('file:get', { path: 'a' })
      expect(result.current.isLoading).toBe(true)

      await settle(() => pending[0].resolve('A'))

      expect(result.current.data).toBe('A')
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('ignores an older response that resolves after a newer one', async () => {
      const { api, invoke, pending } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })

      rerender({ channel: 'file:get', params: { path: 'b' } })
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(pending[1].params).toEqual({ path: 'b' })

      await settle(() => pending[1].resolve('B'))
      expect(result.current.data).toBe('B')

      await settle(() => pending[0].resolve('A'))
      expect(result.current.data).toBe('B')
      expect(result.current.isLoading).toBe(false)
    })

    it('ignores an older rejection that settles after a newer response', async () => {
      const { api, pending } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })

      rerender({ channel: 'file:get', params: { path: 'b' } })
      await settle(() => pending[1].resolve('B'))
      await settle(() => pending[0].reject(new Error('stale failure')))

      expect(result.current.data).toBe('B')
      expect(result.current.error).toBeNull()
    })

    it('does not re-fetch when params change identity but not content', () => {
      const { api, invoke } = createControllableApi()
      const { rerender } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })

      rerender({ channel: 'file:get', params: { path: 'a' } })

      expect(invoke).toHaveBeenCalledTimes(1)
    })

    it('leaves state alone when the main process reports the call as superseded', async () => {
      const { api, pending } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: 'boilerplate:render', params: { v: 1 } })
      await settle(() => pending[0].resolve('first'))

      act(() => result.current.refetch())
      expect(result.current.isLoading).toBe(true)
      await settle(() => pending[1].resolve({ superseded: true }))

      // Not committed as data; the newer call that superseded it drives state.
      expect(result.current.data).toBe('first')
      expect(result.current.error).toBeNull()
      expect(result.current.isLoading).toBe(true)
    })
  })

  describe('errors', () => {
    it("strips Electron's IPC wrapper and repeated Error: prefixes from the message", async () => {
      const { api, pending } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })

      await settle(() =>
        pending[0].reject(new Error("Error invoking remote method 'file:get': Error: Error: boom"))
      )

      expect(result.current.error?.message).toBe('boom')
      expect(result.current.error?.details).toBe('boom')
      expect(result.current.isLoading).toBe(false)
    })

    it('reports a generic message for a non-Error rejection', async () => {
      const { api, pending } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })

      await settle(() => pending[0].reject('not an Error'))

      expect(result.current.error?.message).toBe('An unexpected error occurred')
    })

    it('clears the error when a refetch succeeds', async () => {
      const { api, pending } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })
      await settle(() => pending[0].reject(new Error('boom')))
      expect(result.current.error).not.toBeNull()

      act(() => result.current.refetch())
      await settle(() => pending[1].resolve('A'))

      expect(result.current.error).toBeNull()
      expect(result.current.data).toBe('A')
    })
  })

  describe('lazy + debouncedRequest', () => {
    const lazyOptions: UseIpcOptions = { lazy: true, debounceMs: 300 }

    it('does not fetch on mount', () => {
      const { api, invoke } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: 'boilerplate:render-inline', options: lazyOptions })

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.isLoading).toBe(false)
    })

    it('collapses a burst of requests into one invoke with the last params', async () => {
      vi.useFakeTimers()
      const { api, invoke, pending } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: 'boilerplate:render-inline', options: lazyOptions })

      act(() => result.current.debouncedRequest!({ v: 1 }))
      act(() => vi.advanceTimersByTime(100))
      act(() => result.current.debouncedRequest!({ v: 2 }))
      act(() => vi.advanceTimersByTime(100))
      act(() => result.current.debouncedRequest!({ v: 3 }))
      act(() => vi.advanceTimersByTime(299))
      expect(invoke).not.toHaveBeenCalled()

      act(() => vi.advanceTimersByTime(1))
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith('boilerplate:render-inline', { v: 3 })
      expect(result.current.isLoading).toBe(true)

      await settle(() => pending[0].resolve('rendered'))
      expect(result.current.data).toBe('rendered')
      expect(result.current.isLoading).toBe(false)
    })

    it('sends nothing when the hook unmounts before the debounce delay elapses', () => {
      vi.useFakeTimers()
      const { api, invoke } = createControllableApi()
      const { result, unmount } = renderUseIpc(api, { channel: 'boilerplate:render-inline', options: lazyOptions })

      act(() => result.current.debouncedRequest!({ v: 1 }))
      unmount()
      act(() => vi.advanceTimersByTime(1000))

      expect(invoke).not.toHaveBeenCalled()
    })

    it('keeps existing data when params change (the consumer drives fetches)', async () => {
      vi.useFakeTimers()
      const { api, invoke, pending } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: 'boilerplate:render-inline',
        params: { v: 1 },
        options: lazyOptions,
      })
      act(() => result.current.debouncedRequest!({ v: 1 }))
      act(() => vi.advanceTimersByTime(300))
      await settle(() => pending[0].resolve('rendered'))

      rerender({ channel: 'boilerplate:render-inline', params: { v: 2 }, options: lazyOptions })

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(result.current.data).toBe('rendered')
    })
  })

  describe('disabled / cleared channel', () => {
    it('does not fetch while disabled', () => {
      const { api, invoke } = createControllableApi()
      const { result } = renderUseIpc(api, {
        channel: 'file:get',
        params: { path: 'a' },
        options: { disabled: true },
      })

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toBeNull()
    })

    it('fetches once it goes from disabled to enabled', async () => {
      const { api, invoke, pending } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: 'file:get',
        params: { path: 'a' },
        options: { disabled: true },
      })

      rerender({ channel: 'file:get', params: { path: 'a' }, options: { disabled: false } })

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith('file:get', { path: 'a' })
      expect(result.current.isLoading).toBe(true)
      await settle(() => pending[0].resolve('A'))
      expect(result.current.data).toBe('A')
    })

    it('clears data and error when disabled', async () => {
      const { api, pending } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })
      await settle(() => pending[0].resolve('A'))

      rerender({ channel: 'file:get', params: { path: 'a' }, options: { disabled: true } })

      expect(result.current.data).toBeNull()
      expect(result.current.error).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })

    it('drops an in-flight response that settles after the channel is cleared', async () => {
      const { api, pending } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, { channel: 'file:get', params: { path: 'a' } })

      rerender({ channel: '', params: { path: 'a' } })
      await settle(() => pending[0].resolve('A'))

      expect(result.current.data).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })

    it('cancels a pending debounced request when disabled', () => {
      vi.useFakeTimers()
      const { api, invoke } = createControllableApi()
      const options: UseIpcOptions = { lazy: true, debounceMs: 300 }
      const { result, rerender } = renderUseIpc(api, { channel: 'boilerplate:render', options })

      act(() => result.current.debouncedRequest!({ v: 1 }))
      rerender({ channel: 'boilerplate:render', options: { ...options, disabled: true } })
      act(() => vi.advanceTimersByTime(1000))

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.data).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })

    it('cancels a pending debounced request when the channel is cleared', () => {
      vi.useFakeTimers()
      const { api, invoke } = createControllableApi()
      const options: UseIpcOptions = { lazy: true, debounceMs: 300 }
      const { result, rerender } = renderUseIpc(api, { channel: 'boilerplate:render', options })

      act(() => result.current.debouncedRequest!({ v: 1 }))
      // The timer holds the performInvoke captured with the old channel, so
      // only clearing the timer (not bumping the request seq) stops it.
      rerender({ channel: '', options })
      act(() => vi.advanceTimersByTime(1000))

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.data).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })
  })
})
