import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { makeTestApi } from "@/test/test-api"
import { useIpcWatchMode } from "./useIpcWatchMode"

// Mock boundary: the preload API, as the typed fake. Tests fire
// watch:file-change through it and count its live subscriptions.
function createWatchApi() {
  const testApi = makeTestApi()
  return {
    api: testApi.api,
    on: testApi.on,
    subscriptions: () => testApi.listenerCount("watch:file-change"),
    fileChanged: (path: string) => testApi.emit("watch:file-change", { type: "reload", path }),
  }
}

function renderWatchHook(
  api: RunbooksAPI,
  initial: { onFileChange: () => void; isWatchMode: boolean },
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiProvider api={api}>{children}</ApiProvider>
  )
  return renderHook(({ onFileChange, isWatchMode }) => useIpcWatchMode(onFileChange, isWatchMode), {
    wrapper,
    initialProps: initial,
  })
}

describe("useIpcWatchMode", () => {
  it("does not listen when watch mode is off", () => {
    const watch = createWatchApi()
    renderWatchHook(watch.api, { onFileChange: vi.fn(), isWatchMode: false })

    expect(watch.on).not.toHaveBeenCalled()
  })

  it("subscribes once across re-renders with a new callback and calls the latest one with the runbook path", () => {
    const watch = createWatchApi()
    const first = vi.fn()
    const { rerender } = renderWatchHook(watch.api, { onFileChange: first, isWatchMode: true })

    // A parent that passes a fresh callback identity on every render.
    const latest = vi.fn()
    rerender({ onFileChange: vi.fn(), isWatchMode: true })
    rerender({ onFileChange: latest, isWatchMode: true })

    expect(watch.on).toHaveBeenCalledTimes(1)
    expect(watch.subscriptions()).toBe(1)

    watch.fileChanged("/work/a/runbook.mdx")
    expect(latest).toHaveBeenCalledTimes(1)
    expect(latest).toHaveBeenCalledWith("/work/a/runbook.mdx")
    expect(first).not.toHaveBeenCalled()
  })

  it("unsubscribes when watch mode turns off and on unmount", () => {
    const watch = createWatchApi()
    const { rerender, unmount } = renderWatchHook(watch.api, {
      onFileChange: vi.fn(),
      isWatchMode: true,
    })
    expect(watch.subscriptions()).toBe(1)

    rerender({ onFileChange: vi.fn(), isWatchMode: false })
    expect(watch.subscriptions()).toBe(0)

    rerender({ onFileChange: vi.fn(), isWatchMode: true })
    expect(watch.subscriptions()).toBe(1)

    unmount()
    expect(watch.subscriptions()).toBe(0)
  })
})
