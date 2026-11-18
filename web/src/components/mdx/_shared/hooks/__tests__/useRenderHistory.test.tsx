import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type TestApi } from "@/test/test-api"
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

let testApi: TestApi

/** The `render` events sent to the main process, oldest first. */
const recorded = () =>
  testApi
    .callsTo("session:record-event")
    .filter((event) => event.kind === "render")
    .map((event) => event.payload)

const hashOf = (text: string) =>
  act(async () => {
    pendingHashes.get(text)!(`hash-of-${text}`)
  })

describe("useRenderHistory", () => {
  beforeEach(() => {
    testApi = makeTestApi({ "session:record-event": () => ({ ok: true }) })
    pendingHashes.clear()
  })

  it("records only the latest write when an older write's hash comes back last", async () => {
    const { result } = renderHook(() => useRenderHistory("tpl"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <ApiProvider api={testApi.api}>
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
