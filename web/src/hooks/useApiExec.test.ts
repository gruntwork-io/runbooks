import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { useApiExec } from './useApiExec'
import { SessionContext } from '@/contexts/SessionContext.types'

// =============================================================================
// useApiExec SSE State Machine Tests
// =============================================================================
//
// These tests verify the core execution engine's state transitions via realistic
// SSE streams. useApiExec is the most complex hook in the codebase — if it gets
// stuck in 'running' or mishandles events, the user can't execute anything.
//
// Mock boundary: Only fetch is mocked (returning a ReadableStream of SSE text).
// Everything else — Zod parsing, state transitions, log accumulation — runs as
// real production code.

// --- Test helpers ---

/** Minimal SessionContext wrapper that provides a fake getAuthHeader */
function createSessionWrapper() {
  const sessionValue = {
    isReady: true,
    getAuthHeader: () => ({ Authorization: 'Bearer test-token' }),
    resetSession: async () => {},
    error: null,
  }
  return function SessionWrapper({ children }: { children: ReactNode }) {
    return createElement(SessionContext.Provider, { value: sessionValue }, children)
  }
}

/** Encode SSE events into a ReadableStream, simulating the backend */
function createSSEStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunks = events.map(({ event, data }) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  )

  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
      } else {
        controller.close()
      }
    },
  })
}

/** Create a mock fetch that returns an SSE stream response */
function createSSEFetch(events: Array<{ event: string; data: unknown }>) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      body: createSSEStream(events),
    } as unknown as Response)
  )
}

// --- Tests ---

describe('useApiExec state machine', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('starts in pending state', () => {
    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec(), { wrapper })

    expect(result.current.state.status).toBe('pending')
    expect(result.current.state.logs).toEqual([])
    expect(result.current.state.exitCode).toBeNull()
    expect(result.current.state.error).toBeNull()
  })

  it('happy path: pending → running → logs arrive → success', async () => {
    const fetchSpy = createSSEFetch([
      { event: 'log', data: { line: 'Starting...', timestamp: '2024-01-01T00:00:00Z' } },
      { event: 'log', data: { line: 'Done!', timestamp: '2024-01-01T00:00:01Z' } },
      { event: 'status', data: { status: 'success', exitCode: 0 } },
      { event: 'done', data: {} },
    ])
    globalThis.fetch = fetchSpy

    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec(), { wrapper })

    // Execute
    act(() => {
      result.current.execute('test-executable', { region: 'us-west-2' })
    })

    // Should transition to running immediately
    expect(result.current.state.status).toBe('running')

    // Wait for SSE stream to complete
    await waitFor(() => expect(result.current.state.status).toBe('success'))

    // Verify final state
    expect(result.current.state.exitCode).toBe(0)
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.logs).toHaveLength(2)
    expect(result.current.state.logs[0].line).toBe('Starting...')
    expect(result.current.state.logs[1].line).toBe('Done!')

    // Verify fetch was called with correct payload
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/exec')
    expect(JSON.parse(options.body as string)).toEqual({
      executable_id: 'test-executable',
      template_var_values: { region: 'us-west-2' },
    })
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
  })

  it('error event: running → fail with error message', async () => {
    const fetchSpy = createSSEFetch([
      { event: 'log', data: { line: 'Running script...', timestamp: '2024-01-01T00:00:00Z' } },
      { event: 'error', data: { message: 'Script not found', details: 'No such file' } },
    ])
    globalThis.fetch = fetchSpy

    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec(), { wrapper })

    act(() => {
      result.current.execute('bad-executable')
    })

    await waitFor(() => expect(result.current.state.status).toBe('fail'))

    expect(result.current.state.error).not.toBeNull()
    expect(result.current.state.error!.message).toBe('Script not found')
  })

  it('status fail event: running → fail with exit code', async () => {
    const fetchSpy = createSSEFetch([
      { event: 'log', data: { line: 'Running...', timestamp: '2024-01-01T00:00:00Z' } },
      { event: 'status', data: { status: 'fail', exitCode: 1 } },
      { event: 'done', data: {} },
    ])
    globalThis.fetch = fetchSpy

    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec(), { wrapper })

    act(() => {
      result.current.execute('failing-script')
    })

    await waitFor(() => expect(result.current.state.status).toBe('fail'))
    expect(result.current.state.exitCode).toBe(1)
  })

  it('HTTP error: non-200 response → fail with error', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      } as unknown as Response)
    )

    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec(), { wrapper })

    act(() => {
      result.current.execute('test-executable')
    })

    await waitFor(() => expect(result.current.state.status).toBe('fail'))
    expect(result.current.state.error).not.toBeNull()
    expect(result.current.state.error!.message).toBe('Internal server error')
  })

  it('cancel: running → pending with cancellation log', async () => {
    // Create a stream that never completes (simulates a long-running script)
    const neverEndingStream = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue or close — stream stays open
      },
    })
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        body: neverEndingStream,
      } as unknown as Response)
    )

    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec(), { wrapper })

    act(() => {
      result.current.execute('long-running-script')
    })

    expect(result.current.state.status).toBe('running')

    // Cancel the execution
    act(() => {
      result.current.cancel()
    })

    expect(result.current.state.status).toBe('pending')
    // Should have a cancellation log entry
    const lastLog = result.current.state.logs[result.current.state.logs.length - 1]
    expect(lastLog.line).toContain('cancelled')
  })

  it('reset: clears all state back to initial', async () => {
    const fetchSpy = createSSEFetch([
      { event: 'log', data: { line: 'Output', timestamp: '2024-01-01T00:00:00Z' } },
      { event: 'status', data: { status: 'success', exitCode: 0 } },
      { event: 'done', data: {} },
    ])
    globalThis.fetch = fetchSpy

    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec(), { wrapper })

    act(() => {
      result.current.execute('test-executable')
    })

    await waitFor(() => expect(result.current.state.status).toBe('success'))
    expect(result.current.state.logs).toHaveLength(1)

    // Reset
    act(() => {
      result.current.reset()
    })

    expect(result.current.state.status).toBe('pending')
    expect(result.current.state.logs).toEqual([])
    expect(result.current.state.exitCode).toBeNull()
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.outputs).toBeNull()
  })

  it('outputs event: captures block outputs and invokes callback', async () => {
    const fetchSpy = createSSEFetch([
      { event: 'outputs', data: { outputs: { account_id: '123', region: 'us-west-2' } } },
      { event: 'status', data: { status: 'success', exitCode: 0 } },
      { event: 'done', data: {} },
    ])
    globalThis.fetch = fetchSpy

    const onOutputsCaptured = vi.fn()
    const wrapper = createSessionWrapper()
    const { result } = renderHook(() => useApiExec({ onOutputsCaptured }), { wrapper })

    act(() => {
      result.current.execute('test-executable')
    })

    await waitFor(() => expect(result.current.state.status).toBe('success'))

    expect(result.current.state.outputs).toEqual({ account_id: '123', region: 'us-west-2' })
    expect(onOutputsCaptured).toHaveBeenCalledWith({ account_id: '123', region: 'us-west-2' })
  })
})
