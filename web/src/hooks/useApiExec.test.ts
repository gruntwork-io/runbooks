import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useApiExec } from './useApiExec'

// =============================================================================
// useApiExec IPC State Machine Tests
// =============================================================================
//
// These tests verify the core execution engine's state transitions via IPC events.
// useApiExec subscribes to window.api.on('exec:log'), window.api.on('exec:status'),
// etc., and calls window.api.invoke('exec:run', payload) to start execution.
//
// Mock boundary: window.api is mocked. The IPC event listeners and Zod parsing
// run as real production code.

type EventCallback = (...args: unknown[]) => void

/**
 * Creates a mock window.api that:
 * - Collects event subscriptions via .on()
 * - Allows tests to emit events to those subscribers
 * - Controls when .invoke('exec:run') resolves
 */
function createMockWindowApi() {
  const listeners = new Map<string, Set<EventCallback>>()
  let invokeResolve: ((value?: unknown) => void) | null = null
  let invokeReject: ((err: Error) => void) | null = null
  // Every pending exec:run resolver, in call order. Interleaved-run tests need
  // to settle an *earlier* block's invoke after a later one has started, which
  // the single `invokeResolve` slot above can't express.
  const invokeResolvers: Array<(value?: unknown) => void> = []

  const api = {
    invoke: vi.fn((channel: string, ..._args: unknown[]) => {
      // Fire-and-forget channels (e.g. exec:cancel) resolve immediately so they
      // don't clobber the pending exec:run resolver the tests drive by hand.
      if (channel !== 'exec:run') {
        return Promise.resolve({ ok: true })
      }
      return new Promise<unknown>((resolve, reject) => {
        invokeResolve = resolve
        invokeReject = reject
        invokeResolvers.push(resolve)
      })
    }),
    on: vi.fn((channel: string, callback: EventCallback) => {
      if (!listeners.has(channel)) {
        listeners.set(channel, new Set())
      }
      listeners.get(channel)!.add(callback)
      return () => {
        listeners.get(channel)?.delete(callback)
      }
    }),
    once: vi.fn(),
  }

  return {
    api: api as unknown as typeof window.api,
    /** Emit an event to all listeners on a channel */
    emit(channel: string, data: unknown) {
      const cbs = listeners.get(channel)
      if (cbs) {
        for (const cb of cbs) cb(data)
      }
    },
    /** Resolve the pending invoke('exec:run') call, optionally with a result */
    resolveInvoke(value?: unknown) {
      invokeResolve?.(value)
    },
    /** Reject the pending invoke('exec:run') call */
    rejectInvoke(err: Error) {
      invokeReject?.(err)
    },
    /** Resolve the nth invoke('exec:run') call (0-based, in call order) */
    resolveInvokeNth(index: number, value?: unknown) {
      invokeResolvers[index]?.(value)
    },
  }
}

describe('useApiExec state machine', () => {
  let mock: ReturnType<typeof createMockWindowApi>
  let originalApi: typeof window.api

  beforeEach(() => {
    mock = createMockWindowApi()
    originalApi = window.api
    window.api = mock.api
  })

  afterEach(() => {
    window.api = originalApi
    vi.restoreAllMocks()
  })

  it('starts in pending state', () => {
    const { result } = renderHook(() => useApiExec())

    expect(result.current.state.status).toBe('pending')
    expect(result.current.state.logs).toEqual([])
    expect(result.current.state.exitCode).toBeNull()
    expect(result.current.state.error).toBeNull()
  })

  it('happy path: pending -> running -> logs arrive -> success', async () => {
    const { result } = renderHook(() => useApiExec())

    // Execute
    act(() => {
      result.current.execute('test-executable', { region: 'us-west-2' })
    })

    // Should transition to running immediately
    expect(result.current.state.status).toBe('running')

    // Verify invoke was called with correct payload (plus a generated executionId)
    expect(mock.api.invoke).toHaveBeenCalledWith('exec:run', {
      executableId: 'test-executable',
      templateVarValues: { region: 'us-west-2' },
      envVarsOverride: undefined,
      usePty: undefined,
      timeoutMs: undefined,
      executionId: expect.any(String),
    })

    // Simulate IPC events from main process
    act(() => {
      mock.emit('exec:log', { line: 'Starting...', timestamp: '2024-01-01T00:00:00Z' })
      mock.emit('exec:log', { line: 'Done!', timestamp: '2024-01-01T00:00:01Z' })
      mock.emit('exec:status', { status: 'success', exitCode: 0 })
      mock.resolveInvoke()
    })

    await waitFor(() => expect(result.current.state.status).toBe('success'))

    expect(result.current.state.exitCode).toBe(0)
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.logs).toHaveLength(2)
    expect(result.current.state.logs[0].line).toBe('Starting...')
    expect(result.current.state.logs[1].line).toBe('Done!')
  })

  it('status fail event: running -> fail with exit code', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('failing-script')
    })

    act(() => {
      mock.emit('exec:log', { line: 'Running...', timestamp: '2024-01-01T00:00:00Z' })
      mock.emit('exec:status', { status: 'fail', exitCode: 1 })
      mock.resolveInvoke()
    })

    await waitFor(() => expect(result.current.state.status).toBe('fail'))
    expect(result.current.state.exitCode).toBe(1)
  })

  it('IPC error: invoke rejection -> fail with error', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('test-executable')
    })

    expect(result.current.state.status).toBe('running')

    act(() => {
      mock.rejectInvoke(new Error('IPC channel not found'))
    })

    await waitFor(() => expect(result.current.state.status).toBe('fail'))
    expect(result.current.state.error).not.toBeNull()
    expect(result.current.state.error!.message).toContain('An unexpected error occurred')
  })

  it('cancel: running -> pending with cancellation log', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('long-running-script')
    })

    expect(result.current.state.status).toBe('running')

    // Cancel the execution
    act(() => {
      result.current.cancel()
    })

    expect(result.current.state.status).toBe('pending')
    const lastLog = result.current.state.logs[result.current.state.logs.length - 1]
    expect(lastLog.line).toContain('cancelled')
  })

  it('cancel sends exec:cancel targeting the running execution id', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('long-running-script')
    })
    expect(result.current.state.status).toBe('running')

    act(() => {
      result.current.cancel()
    })

    // Cancel must name an executionId so the backend interrupts *this* run,
    // rather than blindly cancelling whatever is currently active.
    expect(mock.api.invoke).toHaveBeenCalledWith('exec:cancel', {
      executionId: expect.any(String),
    })
    expect(result.current.state.status).toBe('pending')
  })

  it('reconciles final status from the invoke result when the status event is dropped', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('long-running-script')
    })
    expect(result.current.state.status).toBe('running')

    // No exec:status event is emitted (it was dropped: detached listeners, a
    // newer run claimed activeExecId, or the main process suppressed sends). The
    // invoke still resolves with the authoritative result, which must move the UI
    // off "running" — this is the fix for a finished block stuck on "running".
    await act(async () => {
      mock.resolveInvoke({ status: { status: 'success', exitCode: 0 } })
    })

    await waitFor(() => expect(result.current.state.status).toBe('success'))
    expect(result.current.state.exitCode).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // Interrupted runs (main aborts every in-flight execution when a new one
  // starts, resolving the aborted invoke as { status: null, cancelled: true }).
  // ---------------------------------------------------------------------------

  it('an aborted run leaves "running" instead of spinning forever', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('long-running-script')
    })
    expect(result.current.state.status).toBe('running')

    await act(async () => {
      mock.resolveInvoke({ status: null, cancelled: true })
    })

    await waitFor(() => expect(result.current.state.status).toBe('pending'))
    const lastLog = result.current.state.logs[result.current.state.logs.length - 1]
    expect(lastLog.line).toContain('another block was run')
  })

  it('a block interrupted by a second block does not stay stuck on running', async () => {
    const first = renderHook(() => useApiExec())
    const second = renderHook(() => useApiExec())

    act(() => {
      first.result.current.execute('slow-script')
    })
    expect(first.result.current.state.status).toBe('running')

    // Second block starts before the first finishes. The main process aborts
    // the first run and kills its process group, then resolves its invoke with
    // no status — and the first block's listeners are already ignoring events
    // because the newer run owns activeExecId.
    act(() => {
      second.result.current.execute('other-script')
    })
    expect(second.result.current.state.status).toBe('running')

    await act(async () => {
      mock.resolveInvokeNth(0, { status: null, cancelled: true })
    })

    await waitFor(() => expect(first.result.current.state.status).toBe('pending'))
    expect(second.result.current.state.status).toBe('running')
  })

  it('does not explain the stop twice when the user cancelled it', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('long-running-script')
    })
    act(() => {
      result.current.cancel()
    })

    await act(async () => {
      mock.resolveInvoke({ status: null, cancelled: true })
    })

    const lines = result.current.state.logs.map((l) => l.line)
    expect(lines.filter((l) => l.includes('cancelled by user'))).toHaveLength(1)
    expect(lines.some((l) => l.includes('another block was run'))).toBe(false)
  })

  it('cancel still targets this run after its invoke has already resolved', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('long-running-script')
    })
    const runCalls = vi
      .mocked(mock.api.invoke)
      .mock.calls.filter(([channel]) => channel === 'exec:run')
    expect(runCalls).toHaveLength(1)
    const { executionId } = runCalls[0][1] as { executionId: string }

    // The invoke settles (aborted by a newer run) — which used to clear the id
    // Stop depends on, leaving the button wired to nothing.
    await act(async () => {
      mock.resolveInvoke({ status: null, cancelled: true })
    })

    act(() => {
      result.current.cancel()
    })

    expect(mock.api.invoke).toHaveBeenCalledWith('exec:cancel', { executionId })
  })

  it('reset: clears all state back to initial', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('test-executable')
    })

    act(() => {
      mock.emit('exec:log', { line: 'Output', timestamp: '2024-01-01T00:00:00Z' })
      mock.emit('exec:status', { status: 'success', exitCode: 0 })
      mock.resolveInvoke()
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
    const onOutputsCaptured = vi.fn()
    const { result } = renderHook(() => useApiExec({ onOutputsCaptured }))

    act(() => {
      result.current.execute('test-executable')
    })

    act(() => {
      mock.emit('exec:outputs', { outputs: { account_id: '123', region: 'us-west-2' } })
      mock.emit('exec:status', { status: 'success', exitCode: 0 })
      mock.resolveInvoke()
    })

    await waitFor(() => expect(result.current.state.status).toBe('success'))

    expect(result.current.state.outputs).toEqual({ account_id: '123', region: 'us-west-2' })
    expect(onOutputsCaptured).toHaveBeenCalledWith({ account_id: '123', region: 'us-west-2' })
  })

  it('warn status: exit code 2 sets warn status', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('warn-script')
    })

    act(() => {
      mock.emit('exec:status', { status: 'warn', exitCode: 2 })
      mock.resolveInvoke()
    })

    await waitFor(() => expect(result.current.state.status).toBe('warn'))
    expect(result.current.state.exitCode).toBe(2)
  })

  it('cleans up event subscriptions on next execution', async () => {
    const { result } = renderHook(() => useApiExec())

    act(() => {
      result.current.execute('test-executable')
    })

    // Event subscriptions should be registered
    expect(mock.api.on).toHaveBeenCalledWith('exec:log', expect.any(Function))
    expect(mock.api.on).toHaveBeenCalledWith('exec:status', expect.any(Function))
    expect(mock.api.on).toHaveBeenCalledWith('exec:outputs', expect.any(Function))
    expect(mock.api.on).toHaveBeenCalledWith('exec:files-captured', expect.any(Function))

    act(() => {
      mock.emit('exec:status', { status: 'success', exitCode: 0 })
      mock.resolveInvoke()
    })

    await waitFor(() => expect(result.current.state.status).toBe('success'))

    // After the invoke resolves, listeners are cleaned up on the next
    // macrotask (setTimeout(0)). By the time waitFor settles above, that
    // cleanup has already run, so late events are no longer accepted.
    const logCountAfter = result.current.state.logs.length
    act(() => {
      mock.emit('exec:log', { line: 'late arriving', timestamp: '2024-01-01T00:00:00Z' })
    })
    expect(result.current.state.logs.length).toBe(logCountAfter)

    // Starting a new execution cleans up old listeners
    act(() => {
      result.current.execute('second-run')
    })
    expect(result.current.state.status).toBe('running')
    expect(result.current.state.logs).toEqual([]) // Fresh state
  })
})
