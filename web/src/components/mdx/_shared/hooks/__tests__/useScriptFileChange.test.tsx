import { describe, it, expect, afterEach, vi } from "vitest"
import type { ReactNode } from "react"
import { renderHook, cleanup, waitFor } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi } from "@/test/test-api"
import { useScriptFileChange, watchScriptChange } from "../useScriptFileChange"

// More script blocks than ipcRenderer's default limit of 10 listeners per channel.
const BLOCK_COUNT = 12

function setup() {
  const testApi = makeTestApi({ "runbook:script-change": () => ({ change: null }) })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={testApi.api}>{children}</ApiProvider>
  )
  const blocks = Array.from({ length: BLOCK_COUNT }, (_, i) =>
    renderHook(({ executableId }) => useScriptFileChange(`block-${i}`, executableId), {
      wrapper,
      initialProps: { executableId: "entry-1" as string | undefined },
    }),
  )
  const checksOf = (componentId: string) =>
    testApi.callsTo("runbook:script-change").filter((p) => p.componentId === componentId).length
  const listeners = () => testApi.listenerCount("watch:script-change")
  return { testApi, blocks, checksOf, listeners }
}

afterEach(() => {
  cleanup()
})

describe("useScriptFileChange watch:script-change listener", () => {
  it("shares one listener among all mounted blocks", () => {
    const { testApi, listeners } = setup()
    expect(listeners()).toBe(1)
    expect(testApi.on).toHaveBeenCalledTimes(1)
  })

  it("keeps one listener across re-renders and new registry entries", () => {
    const { blocks, listeners } = setup()
    for (let i = 0; i < 3; i++) {
      for (const block of blocks) block.rerender({ executableId: "entry-1" })
      expect(listeners()).toBe(1)
    }
    for (const block of blocks) block.rerender({ executableId: "entry-2" })
    expect(listeners()).toBe(1)
  })

  it("removes the listener once every block unmounts or loses its script", () => {
    const { blocks, listeners } = setup()
    const [first, ...rest] = blocks
    const last = rest.pop()
    first?.rerender({ executableId: undefined })
    for (const block of rest) block.unmount()
    expect(listeners()).toBe(1)
    last?.unmount()
    expect(listeners()).toBe(0)
  })

  it("checks only the blocks the event names", async () => {
    const { testApi, checksOf } = setup()
    await waitFor(() => expect(checksOf("block-3")).toBe(1))
    expect(checksOf("block-4")).toBe(1)

    testApi.emit("watch:script-change", { componentIds: ["block-3", "unknown"] })

    await waitFor(() => expect(checksOf("block-3")).toBe(2))
    expect(checksOf("block-4")).toBe(1)
  })
})

describe("watchScriptChange", () => {
  it("treats each call as its own subscription", () => {
    const testApi = makeTestApi()
    const onChange = vi.fn()
    const first = watchScriptChange(testApi.api, "a", onChange)
    const second = watchScriptChange(testApi.api, "a", onChange)

    testApi.emit("watch:script-change", { componentIds: ["a"] })
    expect(onChange).toHaveBeenCalledTimes(2)

    first()
    first()
    testApi.emit("watch:script-change", { componentIds: ["a"] })
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(testApi.listenerCount("watch:script-change")).toBe(1)

    second()
    expect(testApi.listenerCount("watch:script-change")).toBe(0)
  })

  it("subscribes again after the last subscription ends", () => {
    const testApi = makeTestApi()
    watchScriptChange(testApi.api, "a", () => {})()
    const onChange = vi.fn()
    const stop = watchScriptChange(testApi.api, "b", onChange)

    testApi.emit("watch:script-change", { componentIds: ["b"] })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(testApi.listenerCount("watch:script-change")).toBe(1)
    stop()
  })
})
