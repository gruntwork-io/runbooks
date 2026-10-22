import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { DESKTOP_LAYOUT_QUERY, useMediaQuery } from "../useMediaQuery"

type Listener = () => void

/** A matchMedia whose single list the test flips, as the OS or a resize would. */
function installMatchMedia(initial: boolean) {
  let matches = initial
  const listeners = new Set<Listener>()
  const mql = {
    get matches() {
      return matches
    },
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  }
  const matchMedia = vi.fn().mockReturnValue(mql)
  window.matchMedia = matchMedia as unknown as typeof window.matchMedia
  return {
    matchMedia,
    listeners,
    set(next: boolean) {
      matches = next
      listeners.forEach((l) => l())
    },
  }
}

const originalMatchMedia = window.matchMedia

afterEach(() => {
  window.matchMedia = originalMatchMedia
})

describe("useMediaQuery", () => {
  it("reports the current match and follows changes", () => {
    const mm = installMatchMedia(false)
    const { result } = renderHook(() => useMediaQuery("(min-width: 100px)"))
    expect(result.current).toBe(false)

    act(() => mm.set(true))
    expect(result.current).toBe(true)
    act(() => mm.set(false))
    expect(result.current).toBe(false)
  })

  it("stops listening on unmount", () => {
    const mm = installMatchMedia(false)
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 100px)"))
    expect(mm.listeners.size).toBe(1)
    unmount()
    expect(mm.listeners.size).toBe(0)
  })
})

describe("DESKTOP_LAYOUT_QUERY", () => {
  it("matches Tailwind's lg breakpoint in App.css", () => {
    const appCss = readFileSync(path.resolve(__dirname, "../../css/App.css"), "utf8")
    const breakpoint = /--breakpoint-lg:\s*([^;\s]+);/.exec(appCss)?.[1]
    expect(breakpoint).toBeDefined()
    expect(DESKTOP_LAYOUT_QUERY).toBe(`(min-width: ${breakpoint})`)
  })
})
