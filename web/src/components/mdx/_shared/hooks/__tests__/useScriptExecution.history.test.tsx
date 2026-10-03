import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"
import { renderHook, act, cleanup, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { isSensitiveOutput, revealOutputs } from "@/lib/outputValues"
import { useScriptExecution } from "../useScriptExecution"
import type { SavedBlockState } from "../../../../../../../src/domain/session/history"

// A Command's hook under the real session history provider and runbook
// context. The mock boundary is the preload API: exec:run and its events come
// from the test, and session:record-event is where a run leaves the renderer.
// Only the contexts that would need their own providers are stubbed.
vi.mock("@/hooks/useExecutableRegistry", () => {
  const registry = {
    getExecutableByComponentId: (componentId: string) => ({
      id: `exec-${componentId}`,
      componentId,
    }),
    registryVersion: 0,
  }
  return { useExecutableRegistry: () => registry }
})
vi.mock("@/hooks/useGeneratedFiles", () => {
  const ctx = { updateGeneratedFileTree: () => {} }
  return { useGeneratedFiles: () => ctx }
})
vi.mock("@/contexts/useGitWorkTree", () => {
  const ctx = { invalidateGitFileTree: () => {} }
  return { useGitWorkTree: () => ctx }
})
vi.mock("@/contexts/useLogs", () => {
  const ctx = { registerLogs: () => {} }
  return { useLogs: () => ctx }
})

let invoke: ReturnType<typeof vi.fn>
let api: RunbooksAPI
let listeners: Map<string, Set<(data: unknown) => void>>
/** Ends the exec:run in flight, as the main process does with its result. */
let endRun: (result: unknown) => void
const originalApi = window.api

beforeEach(() => {
  listeners = new Map()
  invoke = vi.fn((channel: string) => {
    if (channel === "exec:run") {
      return new Promise((resolve) => {
        endRun = resolve
      })
    }
    return Promise.resolve({ ok: true })
  })
  const on = (channel: string, listener: (data: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set()
    set.add(listener)
    listeners.set(channel, set)
    return () => set.delete(listener)
  }
  api = { invoke, on } as unknown as RunbooksAPI
  // useApiExec runs and cancels through window.api directly.
  window.api = api
})

afterEach(() => {
  cleanup()
  window.api = originalApi
})

const emit = (channel: string, data: unknown) => {
  listeners.get(channel)?.forEach((listener) => listener(data))
}

/** The payload of each run event sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .filter(([channel]) => channel === "session:record-event")
    .map(([, event]) => {
      expect(event).toMatchObject({ sessionId: "s1", blockId: "deploy", kind: "run" })
      return (event as { payload: unknown }).payload
    })

/** Mount the block in a session whose history says it was left as `saved`. */
function renderBlock(saved?: unknown) {
  const blockStates: SavedBlockState[] =
    saved === undefined ? [] : [{ blockId: "deploy", kind: "run", payload: saved }]
  return renderHook(
    () => ({
      exec: useScriptExecution({
        componentId: "deploy",
        componentType: "command",
        command: "deploy",
      }),
      runbook: useRunbookContext(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ApiProvider api={api}>
          <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
            <RunbookContextProvider>{children}</RunbookContextProvider>
          </IpcSessionHistoryProvider>
        </ApiProvider>
      ),
    },
  )
}

const LOG = { line: "deployed", timestamp: "2026-01-01T00:00:01.000Z" }
const LOG_FILE = "/sessions/elegant-elephant/.runbooks/logs/deploy/run.log"

describe("useScriptExecution in a session", () => {
  it("adds a run to the history when it starts, and when it ends with its logs and outputs", async () => {
    const { result } = renderBlock()
    expect(recorded()).toEqual([])

    act(() => result.current.exec.execute())

    expect(recorded()).toEqual([{ status: "running" }])

    act(() => {
      emit("exec:log-file", { path: LOG_FILE })
      emit("exec:log", LOG)
      emit("exec:outputs", {
        outputs: {
          url: { value: "https://x", sensitive: false },
          token: { value: "s3cret", sensitive: true },
        },
      })
      emit("exec:status", { status: "success", exitCode: 0 })
    })
    await act(async () => endRun({ status: { status: "success", exitCode: 0 } }))

    await waitFor(() => expect(recorded()).toHaveLength(2))
    expect(recorded()[1]).toEqual({
      status: "success",
      exitCode: 0,
      logs: [LOG],
      omittedLogLines: 0,
      logFile: LOG_FILE,
      outputsOmitted: false,
      outputs: {
        url: { value: "https://x", sensitive: false },
        token: { value: "s3cret", sensitive: true },
      },
      error: null,
    })
  })

  it("adds a stopped run as not run, with the line that says it was stopped", async () => {
    const { result } = renderBlock()
    act(() => result.current.exec.execute())
    act(() => emit("exec:log", LOG))

    act(() => result.current.exec.cancel())
    await act(async () => endRun({ status: null, cancelled: true }))

    await waitFor(() => expect(recorded()).toHaveLength(2))
    expect(recorded()[1]).toMatchObject({
      status: "pending",
      exitCode: null,
      logs: [LOG, { line: "Execution cancelled by user" }],
      outputs: null,
    })
  })

  it("starts from the last run the history has, with its outputs back in the runbook context", async () => {
    const { result } = renderBlock({
      status: "warn",
      exitCode: 2,
      logs: [LOG],
      omittedLogLines: 0,
      logFile: LOG_FILE,
      outputsOmitted: false,
      outputs: {
        url: { value: "https://x", sensitive: false },
        token: { value: "s3cret", sensitive: true },
      },
      error: null,
    })

    // A Command shows a warning as a failure.
    expect(result.current.exec.status).toBe("fail")
    expect(result.current.exec.logs).toEqual([LOG])
    expect(result.current.exec.logFilePath).toBe(LOG_FILE)
    const shown = result.current.exec.outputs ?? {}
    expect(isSensitiveOutput(shown.token!)).toBe(true)

    await waitFor(() => expect(result.current.runbook.blockOutputs.deploy).toBeDefined())
    const registered = result.current.runbook.blockOutputs.deploy!.values
    expect(isSensitiveOutput(registered.token!)).toBe(true)
    expect(revealOutputs(registered)).toEqual({ url: "https://x", token: "s3cret" })
    // Starting from a saved run is not a run.
    expect(recorded()).toEqual([])
  })

  it("starts a block whose run never ended as not run, with an error that says so", () => {
    const { result } = renderBlock({ status: "running" })

    expect(result.current.exec.status).toBe("pending")
    expect(result.current.exec.execError?.message).toBe("The last run of this block did not finish")
    expect(result.current.runbook.blockOutputs.deploy).toBeUndefined()
  })

  it("has a block that unmounts mid-run as not finished when it mounts again", () => {
    // As a watch-mode reload does: the run is stopped, and nothing reports its end.
    const first = renderBlock()
    act(() => first.result.current.exec.execute())
    const [started] = recorded()
    first.unmount()

    const { result } = renderBlock(started)

    expect(result.current.exec.status).toBe("pending")
    expect(result.current.exec.execError?.message).toBe("The last run of this block did not finish")
  })

  it("starts over from a state it can't read", () => {
    const { result } = renderBlock({ status: "from-a-later-version" })

    expect(result.current.exec.status).toBe("pending")
    expect(result.current.exec.logs).toEqual([])
  })
})
