import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useApi } from './useApi'

// =============================================================================
// useApi Dependency Stability Tests
// =============================================================================
//
// These tests verify that useApi does NOT re-fetch when hook arguments change
// object identity but not content. This prevents infinite render loops caused by
// callers passing unstable object references (e.g., a new { source: '...' }
// object on every render).
//
// WHY THIS EXISTS:
// A past bug was caused by passing getAuthHeader() (which returns a new object
// each render) as extraHeaders to useApi. The new object identity triggered
// performFetch → useEffect → setState → re-render → new object → infinite loop.
// Both extraHeaders and body are now ref-protected with content-based change
// detection. These tests guard against regressions.

function createMockFetch(data: unknown = { ok: true }) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
    } as Response)
  )
}

describe('useApi dependency stability', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('does not re-fetch when extraHeaders object identity changes', async () => {
    const fetchSpy = createMockFetch()
    globalThis.fetch = fetchSpy

    const { rerender } = renderHook(
      ({ headers }) => useApi('/api/test', 'POST', undefined, undefined, headers),
      { initialProps: { headers: { Authorization: 'Bearer tok' } } }
    )

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

    // Re-render with a NEW object that has the SAME content.
    // Without the ref-based fix, this would trigger an infinite loop.
    rerender({ headers: { Authorization: 'Bearer tok' } })

    // Wait a tick to ensure no additional fetch is queued
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not re-fetch when body object identity changes but content is the same', async () => {
    const fetchSpy = createMockFetch()
    globalThis.fetch = fetchSpy

    const { rerender } = renderHook(
      ({ body }) => useApi('/api/test', 'POST', body),
      { initialProps: { body: { source: 'test-module' } as Record<string, unknown> } }
    )

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

    // Re-render with a new object, same content
    rerender({ body: { source: 'test-module' } })

    await new Promise((r) => setTimeout(r, 50))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does re-fetch when body content actually changes', async () => {
    const fetchSpy = createMockFetch()
    globalThis.fetch = fetchSpy

    const { rerender } = renderHook(
      ({ body }) => useApi('/api/test', 'POST', body),
      { initialProps: { body: { source: 'module-a' } as Record<string, unknown> } }
    )

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

    // Change the actual content — this SHOULD trigger a re-fetch
    rerender({ body: { source: 'module-b' } })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
  })

  it('does re-fetch when endpoint actually changes', async () => {
    const fetchSpy = createMockFetch()
    globalThis.fetch = fetchSpy

    const { rerender } = renderHook(
      ({ endpoint }) => useApi(endpoint, 'GET'),
      { initialProps: { endpoint: '/api/first' } }
    )

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))

    rerender({ endpoint: '/api/second' })

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
  })

  it('does not fetch when endpoint is empty', async () => {
    const fetchSpy = createMockFetch()
    globalThis.fetch = fetchSpy

    const { result } = renderHook(() => useApi('', 'GET'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
