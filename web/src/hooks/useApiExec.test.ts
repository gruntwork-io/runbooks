import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, act, waitFor } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type HeldCall, type Payload, type TestApi } from "@/test/test-api"
import { useApiExec, type ExecState } from "./useApiExec"
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
// Mock boundary: the API from ApiProvider is the typed fake from makeTestApi.
// The IPC event listeners and Zod parsing run as real production code.

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
  let testApi: TestApi
  // Every exec:run, in call order, pending until the test settles it.
  let runs: readonly HeldCall<"exec:run">[]

  const renderExec = (options?: Parameters<typeof useApiExec>[0]) =>
    renderHook(() => useApiExec(options), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(ApiProvider, { api: testApi.api }, children),
    })

  /** The latest exec:run, the one a single block's test drives. */
  const latestRun = () => runs.at(-1)!

  /**
   * The executionId of the nth exec:run (0-based, in call order), which main
   * puts on every event of that run. The latest run's by default.
   */
  const runId = (index = runs.length - 1) => {
    const id = runs[index]?.params.executionId
    if (!id) throw new Error(`exec:run #${index} has no executionId`)
    return id
  }

  beforeEach(() => {
    testApi = makeTestApi({ "exec:cancel": () => ({ ok: true }) })
    runs = testApi.hold("exec:run")
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
    expect(testApi.invoke).toHaveBeenCalledWith("exec:run", {
      executableId: "test-executable",
      templateVarValues: { region: "us-west-2" },
      envVarsOverride: undefined,
      usePty: undefined,
      timeoutMs: undefined,
      executionId: expect.any(String),
    })

    // Simulate IPC events from main process
    act(() => {
      testApi.emit("exec:log", {
        executionId: runId(),
        line: "Starting...",
        timestamp: "2024-01-01T00:00:00Z",
      })
      testApi.emit("exec:log", {
        executionId: runId(),
        line: "Done!",
        timestamp: "2024-01-01T00:00:01Z",
      })
      latestRun().resolve(finished("success", 0))
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
      testApi.emit("exec:log", {
        executionId: runId(),
        line: "Running...",
        timestamp: "2024-01-01T00:00:00Z",
      })
      latestRun().resolve(finished("fail", 1))
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
      latestRun().reject(new Error("IPC channel not found"))
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
    expect(testApi.invoke).toHaveBeenCalledWith("exec:cancel", {
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
      latestRun().reject(new Error("IPC channel not found"))
    })

    await waitFor(() => expect(result.current.state.status).toBe("fail"))
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith({}, "fail")
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
    expect(testApi.invoke).not.toHaveBeenCalledWith("exec:cancel", expect.anything())
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
      testApi.emit("exec:log-file", { executionId: runId(0), path: "/logs/first.log" })
      testApi.emit("exec:log-file", { executionId: runId(1), path: "/logs/second.log" })
      testApi.emit("exec:log", {
        executionId: runId(0),
        line: "first: a",
        timestamp: "2024-01-01T00:00:00Z",
      })
      testApi.emit("exec:log", {
        executionId: runId(1),
        line: "second: a",
        timestamp: "2024-01-01T00:00:01Z",
      })
      testApi.emit("exec:log", {
        executionId: runId(0),
        line: "first: b",
        timestamp: "2024-01-01T00:00:02Z",
      })
      runs[1]!.resolve(finished("warn", 2, { id: { value: "2", sensitive: false } }))
    })

    expect(first.result.current.state.logs.map((l) => l.line)).toEqual(["first: a", "first: b"])
    expect(first.result.current.state.logFilePath).toBe("/logs/first.log")
    expect(first.result.current.state.status).toBe("running")
    expect(first.result.current.state.outputs).toBeNull()
    expect(onFirstFinished).not.toHaveBeenCalled()

    expect(second.result.current.state.logs.map((l) => l.line)).toEqual(["second: a"])
    expect(second.result.current.state.logFilePath).toBe("/logs/second.log")
    expect(second.result.current.state.status).toBe("warn")
    expect(onSecondFinished).toHaveBeenCalledWith({ id: "2" }, "warn")

    await act(async () => {
      runs[0]!.resolve(finished("success", 0))
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
    const executionId = runId(0)

    act(() => {
      first.result.current.cancel()
    })

    expect(testApi.callsTo("exec:cancel")).toEqual([{ executionId }])
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
      latestRun().resolve({ status: null, cancelled: true })
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
      latestRun().resolve({ status: null, cancelled: true })
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
    expect(runs).toHaveLength(1)
    const executionId = runId(0)

    // The invoke settles (aborted by main) — which used to clear the id
    // Stop depends on, leaving the button wired to nothing.
    await act(async () => {
      latestRun().resolve({ status: null, cancelled: true })
    })

    act(() => {
      result.current.cancel()
    })

    expect(testApi.invoke).toHaveBeenCalledWith("exec:cancel", { executionId })
  })

  it("reset: clears all state back to initial", async () => {
    const { result } = renderExec()

    act(() => {
      result.current.execute("test-executable")
    })

    act(() => {
      testApi.emit("exec:log", {
        executionId: runId(),
        line: "Output",
        timestamp: "2024-01-01T00:00:00Z",
      })
      latestRun().resolve(finished("success", 0))
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
      latestRun().resolve(
        finished("success", 0, {
          account_id: { value: "123", sensitive: false },
          region: { value: "us-west-2", sensitive: false },
        }),
      )
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))

    expect(result.current.state.outputs).toEqual({ account_id: "123", region: "us-west-2" })
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith({ account_id: "123", region: "us-west-2" }, "success")
  })

  it("outputs: a run that published none finishes with empty outputs", async () => {
    const onFinished = vi.fn()
    const { result } = renderExec({ onFinished })

    act(() => {
      result.current.execute("test-executable")
    })
    act(() => {
      latestRun().resolve(finished("fail", 1))
    })

    await waitFor(() => expect(result.current.state.status).toBe("fail"))
    expect(result.current.state.outputs).toBeNull()
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith({}, "fail")
  })

  it("outputs: a stopped run reports none", async () => {
    const onFinished = vi.fn()
    const { result } = renderExec({ onFinished })

    act(() => {
      result.current.execute("test-executable")
    })
    await act(async () => {
      latestRun().resolve({ status: null, cancelled: true })
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
      latestRun().resolve(
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
    expect(onFinished).toHaveBeenCalledWith(outputs, "success")
    expect(revealOutputs(outputs)).toEqual({
      AWS_SECRET_ACCESS_KEY: "topsecret",
      region: "us-west-2",
    })
  })

  it("files-captured event: passes the backend payload, tree and truncation fields, to the callback", async () => {
    // The exact shape src/domain/exec/executor.ts emits for a step that wrote
    // main.tf to $GENERATED_FILES.
    const payload: Omit<Payload<"exec:files-captured">, "executionId"> = {
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
      testApi.emit("exec:files-captured", { executionId: runId(), ...payload })
      latestRun().resolve(finished("success", 0))
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
      testApi.emit("exec:files-captured", {
        executionId: runId(),
        files: [{ path: "main.tf", size: 19 }],
        count: 1,
      })
      latestRun().resolve(finished("success", 0))
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
      latestRun().resolve(finished("warn", 2))
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
    expect(testApi.on).toHaveBeenCalledWith("exec:log", expect.any(Function))
    expect(testApi.on).toHaveBeenCalledWith("exec:files-captured", expect.any(Function))

    act(() => {
      latestRun().resolve(finished("success", 0))
    })

    await waitFor(() => expect(result.current.state.status).toBe("success"))

    // After the invoke resolves, listeners are cleaned up on the next
    // macrotask (setTimeout(0)). By the time waitFor settles above, that
    // cleanup has already run, so late events are no longer accepted.
    const logCountAfter = result.current.state.logs.length
    act(() => {
      testApi.emit("exec:log", {
        executionId: runId(),
        line: "late arriving",
        timestamp: "2024-01-01T00:00:00Z",
      })
    })
    expect(result.current.state.logs.length).toBe(logCountAfter)

    // Starting a new execution cleans up old listeners
    act(() => {
      result.current.execute("second-run")
    })
    expect(result.current.state.status).toBe("running")
    expect(result.current.state.logs).toEqual([]) // Fresh state
  })

  it("starts from the state it is given", () => {
    const initialState: ExecState = {
      logs: [{ line: "done", timestamp: "2024-01-01T00:00:00Z" }],
      status: "success",
      exitCode: 0,
      error: null,
      outputs: { url: "https://x" },
      logFilePath: null,
    }

    const { result } = renderExec({ initialState })

    expect(result.current.state).toEqual(initialState)
  })

  it("reports a run when it starts, and once when it is over with the state it left", async () => {
    const onRunStarted = vi.fn()
    const onRunEnded = vi.fn()
    const { result } = renderExec({ onRunStarted, onRunEnded })

    act(() => {
      result.current.execute("test-executable")
    })
    expect(onRunStarted).toHaveBeenCalledTimes(1)

    act(() => {
      testApi.emit("exec:log", {
        executionId: runId(),
        line: "Done!",
        timestamp: "2024-01-01T00:00:01Z",
      })
    })
    // The run is not over until exec:run resolves: more events can follow.
    expect(onRunEnded).not.toHaveBeenCalled()
    act(() => {
      testApi.emit("exec:log", {
        executionId: runId(),
        line: "Flushed",
        timestamp: "2024-01-01T00:00:02Z",
      })
      latestRun().resolve(finished("success", 0))
    })

    await waitFor(() => expect(onRunEnded).toHaveBeenCalledTimes(1))
    expect(onRunEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        exitCode: 0,
        logs: [
          { line: "Done!", timestamp: "2024-01-01T00:00:01Z" },
          { line: "Flushed", timestamp: "2024-01-01T00:00:02Z" },
        ],
      }),
    )
  })

  it("reports a run that exec:run rejected as over, with the failure", async () => {
    const onRunEnded = vi.fn()
    const { result } = renderExec({ onRunEnded })

    act(() => {
      result.current.execute("test-executable")
    })
    act(() => {
      latestRun().reject(new Error("IPC channel not found"))
    })

    await waitFor(() => expect(onRunEnded).toHaveBeenCalledTimes(1))
    expect(onRunEnded.mock.calls[0]![0]).toMatchObject({
      status: "fail",
      error: { details: "IPC channel not found" },
    })
  })

  it("reports each run that is over, one after another, however it ended", async () => {
    const onRunEnded = vi.fn()
    const { result } = renderExec({ onRunEnded })
    const runEndingWith = async (end: () => void, reports: number) => {
      act(() => {
        result.current.execute("test-executable")
      })
      act(end)
      await waitFor(() => expect(onRunEnded).toHaveBeenCalledTimes(reports))
    }

    await runEndingWith(() => latestRun().resolve(finished("success", 0)), 1)
    await runEndingWith(() => latestRun().reject(new Error("IPC channel not found")), 2)
    await runEndingWith(() => latestRun().reject(new Error("IPC channel not found")), 3)
    await runEndingWith(() => latestRun().resolve(finished("fail", 1)), 4)

    expect(onRunEnded.mock.calls.map(([state]) => (state as { status: string }).status)).toEqual([
      "success",
      "fail",
      "fail",
      "fail",
    ])
  })

  it("reports only the newer run when a block is run again before its run is over", async () => {
    const onRunStarted = vi.fn()
    const onRunEnded = vi.fn()
    const { result } = renderExec({ onRunStarted, onRunEnded })

    act(() => {
      result.current.execute("first-run")
    })
    act(() => {
      result.current.execute("second-run")
    })
    // Main aborts the first run when the second starts.
    await act(async () => runs[0]!.resolve({ status: null, cancelled: true }))
    act(() => {
      runs[1]!.resolve(finished("success", 0))
    })

    await waitFor(() => expect(onRunEnded).toHaveBeenCalledTimes(1))
    expect(onRunStarted).toHaveBeenCalledTimes(2)
    expect(onRunEnded.mock.calls[0]![0]).toMatchObject({ status: "success" })
  })
})
