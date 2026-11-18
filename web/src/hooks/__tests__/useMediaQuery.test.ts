import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { DESKTOP_LAYOUT_QUERY, useMediaQuery } from "../useMediaQuery"
import { installMatchMedia } from "@/test/match-media"

const originalMatchMedia = window.matchMedia

afterEach(() => {
  window.matchMedia = originalMatchMedia
})

describe("useMediaQuery", () => {
  it("reports the current match and follows changes", () => {
    const mm = installMatchMedia(false)
    const { result } = renderHook(() => useMediaQuery("(min-width: 100px)"))
    expect(result.current).toBe(false)

    act(() => mm.change(true))
    expect(result.current).toBe(true)
    act(() => mm.change(false))
    expect(result.current).toBe(false)
  })

  it("stops listening on unmount", () => {
    const mm = installMatchMedia(false)
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 100px)"))
    expect(mm.listenerCount()).toBe(1)
    unmount()
    expect(mm.listenerCount()).toBe(0)
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
