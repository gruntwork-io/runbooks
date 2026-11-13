import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { useIpcWatchMode } from "./useIpcWatchMode"

// Mock boundary: the preload API. Tracks live watch:file-change listeners so
// tests can fire the event and count subscriptions.
function createWatchApi() {
  const listeners = new Set<(...args: unknown[]) => void>()
  const on = vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
    if (channel === "watch:file-change") listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  })
  const api = { invoke: vi.fn(), on } as unknown as RunbooksAPI
  return {
    api,
    on,
    listeners,
    fileChanged: (path: string, contentHash: string) =>
      listeners.forEach((cb) => cb({ type: "reload", path, contentHash })),
  }
}

function renderWatchHook(api: RunbooksAPI, initial: { onFileChange: () => void }) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={api}>{children}</ApiProvider>
  )
  return renderHook(({ onFileChange }) => useIpcWatchMode(onFileChange), {
    wrapper,
    initialProps: initial,
  })
}

describe("useIpcWatchMode", () => {
  it("listens with or without watch mode: main reports every change to the open runbook", () => {
    const watch = createWatchApi()
    renderWatchHook(watch.api, { onFileChange: vi.fn() })

    expect(watch.on).toHaveBeenCalledWith("watch:file-change", expect.any(Function))
    expect(watch.listeners.size).toBe(1)
  })

  it("subscribes once across re-renders with a new callback and calls the latest one with the change", () => {
    const watch = createWatchApi()
    const first = vi.fn()
    const { rerender } = renderWatchHook(watch.api, { onFileChange: first })

    // A parent that passes a fresh callback identity on every render.
    const latest = vi.fn()
    rerender({ onFileChange: vi.fn() })
    rerender({ onFileChange: latest })

    expect(watch.on).toHaveBeenCalledTimes(1)
    expect(watch.listeners.size).toBe(1)

    watch.fileChanged("/work/a/runbook.mdx", "hash-2")
    expect(latest).toHaveBeenCalledTimes(1)
    expect(latest).toHaveBeenCalledWith({
      type: "reload",
      path: "/work/a/runbook.mdx",
      contentHash: "hash-2",
    })
    expect(first).not.toHaveBeenCalled()
  })

  it("unsubscribes on unmount", () => {
    const watch = createWatchApi()
    const { unmount } = renderWatchHook(watch.api, { onFileChange: vi.fn() })
    expect(watch.listeners.size).toBe(1)

    unmount()
    expect(watch.listeners.size).toBe(0)
  })
})
