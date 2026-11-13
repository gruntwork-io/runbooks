import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ReactNode } from "react"
import { RunbookLayoutProvider } from "./RunbookLayoutContext"
import { useRunbookLayout } from "./useRunbookLayout"
import { RUNBOOK_LAYOUT_STORAGE_KEY } from "./RunbookLayoutContext.types"

function wrapper({ children }: { children: ReactNode }) {
  return <RunbookLayoutProvider>{children}</RunbookLayoutProvider>
}

describe("RunbookLayoutContext", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it("defaults to a fixed width", () => {
    const { result } = renderHook(() => useRunbookLayout(), { wrapper })
    expect(result.current.layout).toBe("fixed")
  })

  it('reads a stored "fill" preference', () => {
    localStorage.setItem(RUNBOOK_LAYOUT_STORAGE_KEY, "fill")
    const { result } = renderHook(() => useRunbookLayout(), { wrapper })
    expect(result.current.layout).toBe("fill")
  })

  it("treats an unknown stored value as a fixed width", () => {
    localStorage.setItem(RUNBOOK_LAYOUT_STORAGE_KEY, "wide")
    const { result } = renderHook(() => useRunbookLayout(), { wrapper })
    expect(result.current.layout).toBe("fixed")
  })

  it("setLayout persists to localStorage and switches the layout", () => {
    const { result } = renderHook(() => useRunbookLayout(), { wrapper })

    act(() => result.current.setLayout("fill"))
    expect(result.current.layout).toBe("fill")
    expect(localStorage.getItem(RUNBOOK_LAYOUT_STORAGE_KEY)).toBe("fill")

    act(() => result.current.setLayout("fixed"))
    expect(result.current.layout).toBe("fixed")
    expect(localStorage.getItem(RUNBOOK_LAYOUT_STORAGE_KEY)).toBe("fixed")
  })

  it("keeps the choice across a remount, as across a relaunch", () => {
    const first = renderHook(() => useRunbookLayout(), { wrapper })
    act(() => first.result.current.setLayout("fill"))
    first.unmount()

    const { result } = renderHook(() => useRunbookLayout(), { wrapper })
    expect(result.current.layout).toBe("fill")
  })

  it("useRunbookLayout throws when used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => renderHook(() => useRunbookLayout())).toThrow(
      "useRunbookLayout must be used within a RunbookLayoutProvider",
    )
    spy.mockRestore()
  })
})
