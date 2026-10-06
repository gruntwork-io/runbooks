import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, act, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { useApiExec } from "./useApiExec"
import { isSensitiveOutput, revealOutputs } from "@/lib/outputValues"

// =============================================================================
// useApiExec IPC State Machine Tests
// =============================================================================
//
// These tests verify the core execution engine's state transitions over IPC.
// useApiExec subscribes to api.on('exec:log'), api.on('exec:files-captured'),
// etc., and calls api.invoke('exec:run', payload) to start execution. The
// invoke resolves with the run's final status and outputs.
//
// Mock boundary: the API from ApiProvider is mocked. The IPC event listeners
// and Zod parsing run as real production code.

type EventCallback = (...args: unknown[]) => void

/**
 * Creates a mock API that:
 * - Collects event subscriptions via .on()
 * - Allows tests to emit events to those subscribers
 * - Controls when .invoke('exec:run') resolves
 */
function createMockApi() {
  const listeners = new Map<string, Set<EventCallback>>()
  let invokeResolve: ((value?: unknown) => void) | null = null
  let invokeReject: ((err: Error) => void) | null = null
  // Every pending exec:run resolver, in call order. Interleaved-run tests need
  // to settle an *earlier* block's invoke after a later one has started, which
  // the single `invokeResolve` slot above can't express.
  const invokeResolvers: Array<(value?: unknown) => void> = []
  // The executionId of every exec:run, in call order. Main puts the id of its
  // run on each event, so emit() needs them to do the same.
  const executionIds: string[] = []

  const api = {
    invoke: vi.fn((channel: string, ...args: unknown[]) => {
      // Fire-and-forget channels (e.g. exec:cancel) resolve immediately so they
      // don't clobber the pending exec:run resolver the tests drive by hand.
      if (channel !== "exec:run") {
        return Promise.resolve({ ok: true })
      }
      executionIds.push((args[0] as { executionId: string }).executionId)
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
  }

  return {
    api: api as unknown as RunbooksAPI,
    /** Emit an event of the latest exec:run to all listeners on a channel */
    emit(channel: string, data: object) {
      this.emitNth(executionIds.length - 1, channel, data)
    },
    /** Emit an event of the nth exec:run (0-based, in call order) */
    emitNth(index: number, channel: string, data: object) {
      const event = { ...data, executionId: executionIds[index] }
      const cbs = listeners.get(channel)
      if (cbs) {
        for (const cb of cbs) cb(event)
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

type EncodedOutputs = Record<string, { value: string; sensitive: boolean }>

/** The exec:run result of a run that ended as `status`. */
function finished(
  status: "success" | "warn" | "fail",
  exitCode: number,
  outputs: EncodedOutputs = {},
) {
  return { status: { status, exitCode }, outputs }
}

describe("useApiExec state machine", () => {
  let mock: ReturnType<typeof createMockApi>

  const renderExec = (options?: Parameters<typeof useApiExec>[0]) =>
    renderHook(() => useApiExec(options), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(ApiProvider, { api: mock.api }, children),
    })

  beforeEach(() => {
    mock = createMockApi()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts in pending state", () => {
    const { result } = renderExec()

    expect(result.current.state.status).toBe("pending")
    expect(result.current.state.logs).toEqual([])
    expect(result.current.state.exitCode).toBeNull()
    expect(result.current.state.error).toBeNull()
  })

  it("happy path: pending -> running -> logs arrive -> success", async () => {
    const { result } = renderExec()

    // Execute
    act(() => {
      result.current.execute("test-executable", { region: "us-west-2" })
    })

    // Should transition to running immediately
    expect(result.current.state.status).toBe("running")

    // Verify invoke was called with correct payload (plus a generated executionId)
    expect(mock.api.invoke).toHaveBeenCalledWith("exec:run", {
      executableId: "test-executable",
      templateVarValues: { region: "us-west-2" },
      envVarsOverride: undefined,
      usePty: undefined,
      timeoutMs: undefined,
      executionId: expect.any(String),
    })

    // Simulate IPC events from main process
    act(() => {
      mock.emit("exec:log", { line: "Starting...", timestamp: "2024-01-01T00:00:00Z" })
      mock.emit("exec:log", { line: "Done!", timestamp: "2024-01-01T00:00:01Z" })
      mock.resolveInvoke(finished("success", 0))
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))

    expect(result.current.state.exitCode).toBe(0)
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.logs).toHaveLength(2)
    expect(result.current.state.logs[0]!.line).toBe("Starting...")
    expect(result.current.state.logs[1]!.line).toBe("Done!")
  })

  it("failed run: running -> fail with exit code", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("failing-script")
    })

    act(() => {
      mock.emit("exec:log", { line: "Running...", timestamp: "2024-01-01T00:00:00Z" })
      mock.resolveInvoke(finished("fail", 1))
    })

    await waitFor(() => expect(result.current.state.status).toBe("fail"))
    expect(result.current.state.exitCode).toBe(1)
  })

  it("IPC error: invoke rejection -> fail with error", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("test-executable")
    })

    expect(result.current.state.status).toBe("running")

    act(() => {
      mock.rejectInvoke(new Error("IPC channel not found"))
    })

    await waitFor(() => expect(result.current.state.status).toBe("fail"))
    expect(result.current.state.error).not.toBeNull()
    expect(result.current.state.error!.message).toContain("An unexpected error occurred")
  })

  it("cancel: running -> pending with cancellation log", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("long-running-script")
    })

    expect(result.current.state.status).toBe("running")

    // Cancel the execution
    act(() => {
      result.current.cancel()
    })

    expect(result.current.state.status).toBe("pending")
    const lastLog = result.current.state.logs.at(-1)
    expect(lastLog?.line).toContain("cancelled")
  })

  it("cancel sends exec:cancel targeting the running execution id", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("long-running-script")
    })
    expect(result.current.state.status).toBe("running")

    act(() => {
      result.current.cancel()
    })

    // Cancel must name an executionId so the backend interrupts *this* run,
    // rather than blindly cancelling whatever is currently active.
    expect(mock.api.invoke).toHaveBeenCalledWith("exec:cancel", {
      executionId: expect.any(String),
    })
    expect(result.current.state.status).toBe("pending")
  })

  it("IPC error: reports the run as finished with no outputs", async () => {
    const onFinished = vi.fn()
    const { result } = renderExec({ onFinished })

    act(() => {
      result.current.execute("test-executable")
    })
    act(() => {
      mock.rejectInvoke(new Error("IPC channel not found"))
    })

    await waitFor(() => expect(result.current.state.status).toBe("fail"))
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith({})
  })

  // ---------------------------------------------------------------------------
  // Concurrent runs
  // ---------------------------------------------------------------------------

  it("a second block's run leaves the first block's run going", async () => {
    const first = renderExec()
    const second = renderExec()

    act(() => {
      first.result.current.execute("slow-script")
    })
    act(() => {
      second.result.current.execute("other-script")
    })

    expect(first.result.current.state.status).toBe("running")
    expect(second.result.current.state.status).toBe("running")
    expect(mock.api.invoke).not.toHaveBeenCalledWith("exec:cancel", expect.anything())
  })

  it("routes each run's events to the block that started it", async () => {
    const onFirstFinished = vi.fn()
    const onSecondFinished = vi.fn()
    const first = renderExec({ onFinished: onFirstFinished })
    const second = renderExec({ onFinished: onSecondFinished })

    act(() => {
      first.result.current.execute("slow-script")
    })
    act(() => {
      second.result.current.execute("other-script")
    })

    // Interleaved, as two scripts running at once produce them
    await act(async () => {
      mock.emitNth(0, "exec:log-file", { path: "/logs/first.log" })
      mock.emitNth(1, "exec:log-file", { path: "/logs/second.log" })
      mock.emitNth(0, "exec:log", { line: "first: a", timestamp: "2024-01-01T00:00:00Z" })
      mock.emitNth(1, "exec:log", { line: "second: a", timestamp: "2024-01-01T00:00:01Z" })
      mock.emitNth(0, "exec:log", { line: "first: b", timestamp: "2024-01-01T00:00:02Z" })
      mock.resolveInvokeNth(1, finished("warn", 2, { id: { value: "2", sensitive: false } }))
    })

    expect(first.result.current.state.logs.map((l) => l.line)).toEqual(["first: a", "first: b"])
    expect(first.result.current.state.logFilePath).toBe("/logs/first.log")
    expect(first.result.current.state.status).toBe("running")
    expect(first.result.current.state.outputs).toBeNull()
    expect(onFirstFinished).not.toHaveBeenCalled()

    expect(second.result.current.state.logs.map((l) => l.line)).toEqual(["second: a"])
    expect(second.result.current.state.logFilePath).toBe("/logs/second.log")
    expect(second.result.current.state.status).toBe("warn")
    expect(onSecondFinished).toHaveBeenCalledWith({ id: "2" })

    await act(async () => {
      mock.resolveInvokeNth(0, finished("success", 0))
    })
    expect(first.result.current.state.status).toBe("success")
    expect(second.result.current.state.status).toBe("warn")
  })

  it("stopping one block leaves another block's run going", async () => {
    const first = renderExec()
    const second = renderExec()

    act(() => {
      first.result.current.execute("slow-script")
    })
    act(() => {
      second.result.current.execute("other-script")
    })
    const [firstRun] = vi
      .mocked(mock.api.invoke)
      .mock.calls.filter(([channel]) => channel === "exec:run")
    const { executionId } = firstRun![1] as { executionId: string }

    act(() => {
      first.result.current.cancel()
    })

    const cancels = vi
      .mocked(mock.api.invoke)
      .mock.calls.filter(([channel]) => channel === "exec:cancel")
    expect(cancels).toEqual([["exec:cancel", { executionId }]])
    expect(first.result.current.state.status).toBe("pending")
    expect(second.result.current.state.status).toBe("running")
  })

  // ---------------------------------------------------------------------------
  // Interrupted runs (main aborts every execution when the app quits or the
  // window reloads, resolving the aborted invoke as { status: null, cancelled:
  // true }).
  // ---------------------------------------------------------------------------

  it('an aborted run leaves "running" instead of spinning forever', async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("long-running-script")
    })
    expect(result.current.state.status).toBe("running")

    await act(async () => {
      mock.resolveInvoke({ status: null, cancelled: true })
    })

    await waitFor(() => expect(result.current.state.status).toBe("pending"))
    const lastLog = result.current.state.logs.at(-1)
    expect(lastLog?.line).toContain("stopped before it finished")
  })

  it("does not explain the stop twice when the user cancelled it", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("long-running-script")
    })
    act(() => {
      result.current.cancel()
    })

    await act(async () => {
      mock.resolveInvoke({ status: null, cancelled: true })
    })

    const lines = result.current.state.logs.map((l) => l.line)
    expect(lines.filter((l) => l.includes("cancelled by user"))).toHaveLength(1)
    expect(lines.some((l) => l.includes("stopped before it finished"))).toBe(false)
  })

  it("cancel still targets this run after its invoke has already resolved", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("long-running-script")
    })
    const runCalls = vi
      .mocked(mock.api.invoke)
      .mock.calls.filter(([channel]) => channel === "exec:run")
    expect(runCalls).toHaveLength(1)
    const { executionId } = runCalls[0]![1] as { executionId: string }

    // The invoke settles (aborted by main) — which used to clear the id
    // Stop depends on, leaving the button wired to nothing.
    await act(async () => {
      mock.resolveInvoke({ status: null, cancelled: true })
    })

    act(() => {
      result.current.cancel()
    })

    expect(mock.api.invoke).toHaveBeenCalledWith("exec:cancel", { executionId })
  })

  it("reset: clears all state back to initial", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("test-executable")
    })

    act(() => {
      mock.emit("exec:log", { line: "Output", timestamp: "2024-01-01T00:00:00Z" })
      mock.resolveInvoke(finished("success", 0))
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))
    expect(result.current.state.logs).toHaveLength(1)

    // Reset
    act(() => {
      result.current.reset()
    })

    expect(result.current.state.status).toBe("pending")
    expect(result.current.state.logs).toEqual([])
    expect(result.current.state.exitCode).toBeNull()
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.outputs).toBeNull()
  })

  it("outputs: reports a finished run's outputs once, with its status", async () => {
    const onFinished = vi.fn()
    const { result } = renderExec({ onFinished })

    act(() => {
      result.current.execute("test-executable")
    })
    expect(onFinished).not.toHaveBeenCalled()

    act(() => {
      mock.resolveInvoke(
        finished("success", 0, {
          account_id: { value: "123", sensitive: false },
          region: { value: "us-west-2", sensitive: false },
        }),
      )
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))

    expect(result.current.state.outputs).toEqual({ account_id: "123", region: "us-west-2" })
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith({ account_id: "123", region: "us-west-2" })
  })

  it("outputs: a run that published none finishes with empty outputs", async () => {
    const onFinished = vi.fn()
    const { result } = renderExec({ onFinished })

    act(() => {
      result.current.execute("test-executable")
    })
    act(() => {
      mock.resolveInvoke(finished("fail", 1))
    })

    await waitFor(() => expect(result.current.state.status).toBe("fail"))
    expect(result.current.state.outputs).toBeNull()
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith({})
  })

  it("outputs: a stopped run reports none", async () => {
    const onFinished = vi.fn()
    const { result } = renderExec({ onFinished })

    act(() => {
      result.current.execute("test-executable")
    })
    await act(async () => {
      mock.resolveInvoke({ status: null, cancelled: true })
    })

    expect(result.current.state.status).toBe("pending")
    expect(onFinished).not.toHaveBeenCalled()
  })

  it("outputs: wraps a sensitive output again, keeping its real value for downstream blocks", async () => {
    const onFinished = vi.fn()
    const { result } = renderExec({ onFinished })

    act(() => {
      result.current.execute("test-executable")
    })

    act(() => {
      mock.resolveInvoke(
        finished("success", 0, {
          AWS_SECRET_ACCESS_KEY: { value: "topsecret", sensitive: true },
          region: { value: "us-west-2", sensitive: false },
        }),
      )
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))

    const outputs = result.current.state.outputs ?? {}
    expect(isSensitiveOutput(outputs.AWS_SECRET_ACCESS_KEY!)).toBe(true)
    expect(outputs.region).toBe("us-west-2")
    expect(JSON.stringify(outputs)).not.toContain("topsecret")
    // Downstream blocks get the same wrapped outputs, and read the real value
    // through revealOutput
    expect(onFinished).toHaveBeenCalledWith(outputs)
    expect(revealOutputs(outputs)).toEqual({
      AWS_SECRET_ACCESS_KEY: "topsecret",
      region: "us-west-2",
    })
  })

  it("files-captured event: passes the backend payload, tree and truncation fields, to the callback", async () => {
    // The exact shape src/domain/exec/executor.ts emits for a step that wrote
    // main.tf to $GENERATED_FILES.
    const payload = {
      files: [{ path: "main.tf", size: 19 }],
      count: 1,
      fileTree: [
        {
          id: "main.tf",
          name: "main.tf",
          type: "file",
          children: [],
          file: {
            name: "main.tf",
            path: "main.tf",
            content: 'resource "x" "y" {}',
            language: "hcl",
            size: 19,
            isTruncated: false,
          },
        },
      ],
      totalFiles: 1,
      truncatedTree: false,
      heavyDirs: [],
    }
    const onFilesCaptured = vi.fn()
    const { result } = renderExec({ onFilesCaptured })

    act(() => {
      result.current.execute("test-executable")
    })

    act(() => {
      mock.emit("exec:files-captured", payload)
      mock.resolveInvoke(finished("success", 0))
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))
    expect(onFilesCaptured).toHaveBeenCalledTimes(1)
    expect(onFilesCaptured).toHaveBeenCalledWith(payload)
  })

  it("files-captured event without a tree still reaches the callback", async () => {
    // Main omits fileTree when it could not read the output dir; the step
    // still captured files, so the git tree must still refresh.
    const onFilesCaptured = vi.fn()
    const { result } = renderExec({ onFilesCaptured })

    act(() => {
      result.current.execute("test-executable")
    })

    act(() => {
      mock.emit("exec:files-captured", { files: [{ path: "main.tf", size: 19 }], count: 1 })
      mock.resolveInvoke(finished("success", 0))
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))
    expect(onFilesCaptured).toHaveBeenCalledWith({
      files: [{ path: "main.tf", size: 19 }],
      count: 1,
    })
  })

  it("warn status: exit code 2 sets warn status", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("warn-script")
    })

    act(() => {
      mock.resolveInvoke(finished("warn", 2))
    })

    await waitFor(() => expect(result.current.state.status).toBe("warn"))
    expect(result.current.state.exitCode).toBe(2)
  })

  it("cleans up event subscriptions on next execution", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("test-executable")
    })

    // Event subscriptions should be registered
    expect(mock.api.on).toHaveBeenCalledWith("exec:log", expect.any(Function))
    expect(mock.api.on).toHaveBeenCalledWith("exec:files-captured", expect.any(Function))

    act(() => {
      mock.resolveInvoke(finished("success", 0))
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))

    // After the invoke resolves, listeners are cleaned up on the next
    // macrotask (setTimeout(0)). By the time waitFor settles above, that
    // cleanup has already run, so late events are no longer accepted.
    const logCountAfter = result.current.state.logs.length
    act(() => {
      mock.emit("exec:log", { line: "late arriving", timestamp: "2024-01-01T00:00:00Z" })
    })
    expect(result.current.state.logs.length).toBe(logCountAfter)

    // Starting a new execution cleans up old listeners
    act(() => {
      result.current.execute("second-run")
    })
    expect(result.current.state.status).toBe("running")
    expect(result.current.state.logs).toEqual([]) // Fresh state
  })
})
