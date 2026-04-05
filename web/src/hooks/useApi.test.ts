import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { useApi } from './useApi'
import { ApiProvider } from '@/contexts/ApiContext'

// =============================================================================
// useApi Dependency Stability Tests
// =============================================================================
//
// These tests verify that useApi does NOT re-invoke when hook arguments change
// object identity but not content. This prevents infinite render loops caused by
// callers passing unstable object references (e.g., a new { source: '...' }
// object on every render).

function createMockApi(invokeFn: (...args: unknown[]) => Promise<unknown> = () => Promise.resolve({ ok: true })) {
  return {
    invoke: vi.fn(invokeFn) as unknown as typeof window.api.invoke,
    on: vi.fn(() => () => {}) as unknown as typeof window.api.on,
    once: vi.fn() as unknown as typeof window.api.once,
  }
}

function createWrapper(api: ReturnType<typeof createMockApi>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(ApiProvider, { api: api as unknown as typeof window.api, children })
  }
}

describe('useApi dependency stability', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not re-invoke when extraHeaders object identity changes', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    const { rerender } = renderHook(
      ({ headers }) => useApi('/api/session', 'POST', undefined, undefined, headers),
      { wrapper, initialProps: { headers: { Authorization: 'Bearer tok' } } }
    )

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))

    // Re-render with a NEW object that has the SAME content.
    rerender({ headers: { Authorization: 'Bearer tok' } })

    // Wait a tick to ensure no additional invoke is queued
    await new Promise((r) => setTimeout(r, 50))
    expect(api.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not re-invoke when body object identity changes but content is the same', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    const { rerender } = renderHook(
      ({ body }) => useApi('/api/boilerplate/variables', 'POST', body),
      { wrapper, initialProps: { body: { source: 'test-module' } as Record<string, unknown> } }
    )

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))

    // Re-render with a new object, same content
    rerender({ body: { source: 'test-module' } })

    await new Promise((r) => setTimeout(r, 50))
    expect(api.invoke).toHaveBeenCalledTimes(1)
  })

  it('does re-invoke when body content actually changes', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    const { rerender } = renderHook(
      ({ body }) => useApi('/api/boilerplate/variables', 'POST', body),
      { wrapper, initialProps: { body: { source: 'module-a' } as Record<string, unknown> } }
    )

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))

    // Change the actual content — this SHOULD trigger a re-invoke
    rerender({ body: { source: 'module-b' } })

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2))
  })

  it('does re-invoke when endpoint actually changes', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    const { rerender } = renderHook(
      ({ endpoint }) => useApi(endpoint, 'GET'),
      { wrapper, initialProps: { endpoint: '/api/session' } }
    )

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))

    rerender({ endpoint: '/api/runbook' })

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2))
  })

  it('does not invoke when endpoint is empty', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    const { result } = renderHook(() => useApi('', 'GET'), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('does not invoke for unknown endpoints', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    const { result } = renderHook(() => useApi('/unknown/endpoint', 'GET'), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('invokes the correct IPC channel for a known endpoint', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    renderHook(() => useApi('/api/session', 'GET'), { wrapper })

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
    expect(api.invoke).toHaveBeenCalledWith('session:get', undefined)
  })

  it('passes body to IPC invoke', async () => {
    const api = createMockApi()
    const wrapper = createWrapper(api)

    renderHook(
      () => useApi('/api/boilerplate/variables', 'POST', { source: 'my-module' }),
      { wrapper }
    )

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1))
    expect(api.invoke).toHaveBeenCalledWith('boilerplate:variables', { source: 'my-module' })
  })

  it('sets error state when invoke fails', async () => {
    const api = createMockApi(() => Promise.reject(new Error('connection failed')))
    const wrapper = createWrapper(api)

    const { result } = renderHook(
      () => useApi('/api/session', 'GET'),
      { wrapper }
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error!.message).toBe('connection failed')
    expect(result.current.isLoading).toBe(false)
  })

  it('sets data on successful invoke', async () => {
    const api = createMockApi(() => Promise.resolve({ workingDir: '/home', executionCount: 3 }))
    const wrapper = createWrapper(api)

    const { result } = renderHook(
      () => useApi<{ workingDir: string; executionCount: number }>('/api/session', 'GET'),
      { wrapper }
    )

    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.data!.workingDir).toBe('/home')
    expect(result.current.data!.executionCount).toBe(3)
    expect(result.current.isLoading).toBe(false)
  })
})
