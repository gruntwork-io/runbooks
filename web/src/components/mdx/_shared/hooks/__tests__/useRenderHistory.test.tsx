import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useRenderHistory } from "../useRenderHistory"

// The hash is the boundary: each call waits until the test settles it, so the
// test decides the order the hashes of two writes come back in.
const pendingHashes = vi.hoisted(() => new Map<string, (hash: string) => void>())
vi.mock("@/lib/hash", () => ({
  computeSha256Hash: (text: string) =>
    new Promise<string>((resolve) => {
      pendingHashes.set(text, resolve)
    }),
}))

const invoke = vi.fn(async () => ({ ok: true }))
const api = { invoke, on: vi.fn(() => () => {}) } as unknown as RunbooksAPI

/** The `render` events sent to the main process, oldest first. */
const recorded = () =>
  invoke.mock.calls
    .map((call) => call as unknown as [string, { kind: string; payload: unknown }])
    .filter(([channel, event]) => channel === "session:record-event" && event.kind === "render")
    .map(([, event]) => event.payload)

const hashOf = (text: string) =>
  act(async () => {
    pendingHashes.get(text)!(`hash-of-${text}`)
  })

describe("useRenderHistory", () => {
  beforeEach(() => {
    invoke.mockClear()
    pendingHashes.clear()
  })

  it("records only the latest write when an older write's hash comes back last", async () => {
    const { result } = renderHook(() => useRenderHistory("tpl"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ApiProvider api={api}>
          <IpcSessionHistoryProvider sessionId="s1" blockStates={[]}>
            {children}
          </IpcSessionHistoryProvider>
        </ApiProvider>
      ),
    })

    act(() => {
      result.current.noteWritten("first")
      result.current.noteWritten("second")
    })
    await hashOf("second")
    await hashOf("first")

    expect(recorded()).toEqual([{ writtenHash: "hash-of-second" }])
  })
})
