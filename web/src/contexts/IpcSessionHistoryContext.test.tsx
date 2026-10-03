import { describe, it, expect, vi, afterEach } from "vitest"
import type { ReactNode } from "react"
import { renderHook, waitFor } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "./ApiContext"
import { IpcSessionHistoryProvider } from "./IpcSessionHistoryContext"
import { useSessionHistory } from "./useSessionHistory"
import type { SavedBlockState } from "../../../src/domain/session/history"

const FORM = { values: { region: "us-east-1" }, submitted: true }

// Mock boundary: the preload API, which is where an event leaves the renderer.
function renderHistory(
  invoke: RunbooksAPI["invoke"],
  props: { sessionId: string | undefined; blockStates: SavedBlockState[] | undefined },
) {
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI
  return renderHook(() => useSessionHistory(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ApiProvider api={api}>
        <IpcSessionHistoryProvider {...props}>{children}</IpcSessionHistoryProvider>
      </ApiProvider>
    ),
  })
}

describe("IpcSessionHistoryProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("gives a block what the session's history says it was left as", () => {
    const { result } = renderHistory(vi.fn(), {
      sessionId: "s1",
      blockStates: [
        { blockId: "config", kind: "inputs", payload: FORM },
        { blockId: "config", kind: "run", payload: { status: "success" } },
      ],
    })

    expect(result.current.saved("config", "inputs")).toEqual(FORM)
    expect(result.current.saved("config", "run")).toEqual({ status: "success" })
    expect(result.current.saved("deploy", "inputs")).toBeUndefined()
  })

  it("sends an event to the main process for the session, and has it as the block's state", () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    const { result } = renderHistory(invoke as unknown as RunbooksAPI["invoke"], {
      sessionId: "s1",
      blockStates: [
        { blockId: "config", kind: "inputs", payload: { values: {}, submitted: false } },
      ],
    })

    result.current.record("config", "inputs", FORM)

    expect(invoke).toHaveBeenCalledWith("session:record-event", {
      sessionId: "s1",
      blockId: "config",
      kind: "inputs",
      payload: FORM,
    })
    expect(result.current.saved("config", "inputs")).toEqual(FORM)
  })

  it("keeps the block's state when the main process can't save it, and keeps the payload out of the console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const invoke = vi.fn(async () => {
      throw new Error('the inputs event of block "login" is too long')
    })
    const { result } = renderHistory(invoke as unknown as RunbooksAPI["invoke"], {
      sessionId: "s1",
      blockStates: [],
    })
    const secret = { values: { password: "hunter2" }, submitted: true }

    result.current.record("login", "inputs", secret)

    expect(result.current.saved("login", "inputs")).toEqual(secret)
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn.mock.calls[0]![0]).toBe(
      `Could not save the inputs of block "login" to the session's history:`,
    )
    expect(JSON.stringify(warn.mock.calls)).toContain("is too long")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2")
  })

  it("sends nothing while no session is loaded", () => {
    const invoke = vi.fn()
    const { result } = renderHistory(invoke, { sessionId: undefined, blockStates: undefined })

    result.current.record("config", "inputs", FORM)

    expect(invoke).not.toHaveBeenCalled()
  })
})

describe("useSessionHistory outside a provider", () => {
  it("has nothing saved and keeps nothing", () => {
    const { result } = renderHook(() => useSessionHistory())

    result.current.record("config", "inputs", FORM)

    expect(result.current.saved("config", "inputs")).toBeUndefined()
  })
})
