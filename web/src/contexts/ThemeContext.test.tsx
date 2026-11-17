import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ReactNode } from "react"
import { ThemeProvider } from "./ThemeContext"
import { useTheme } from "./useTheme"
import { THEME_STORAGE_KEY } from "./ThemeContext.types"
import { installMatchMedia } from "@/test/match-media"

// jsdom doesn't implement matchMedia: installMatchMedia puts in a fake the
// tests control, to simulate the OS color-scheme preference and live changes
// to it.

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>
}

describe("ThemeContext", () => {
  let mm: ReturnType<typeof installMatchMedia>

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove("dark")
    mm = installMatchMedia(false)
  })

  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove("dark")
  })

  it("defaults to 'system' and resolves against the OS (light)", () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.theme).toBe("system")
    expect(result.current.resolvedTheme).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("resolves 'system' to dark when the OS prefers dark", () => {
    mm = installMatchMedia(true)
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.theme).toBe("system")
    expect(result.current.resolvedTheme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("reads a stored 'dark' preference and applies the .dark class", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark")
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.theme).toBe("dark")
    expect(result.current.resolvedTheme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("setTheme persists to localStorage and toggles the .dark class", () => {
    const { result } = renderHook(() => useTheme(), { wrapper })

    act(() => result.current.setTheme("dark"))
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(result.current.resolvedTheme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    act(() => result.current.setTheme("light"))
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")
    expect(result.current.resolvedTheme).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("follows live OS changes while in system mode", () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.resolvedTheme).toBe("light")

    act(() => mm.change(true))
    expect(result.current.resolvedTheme).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    act(() => mm.change(false))
    expect(result.current.resolvedTheme).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("ignores OS changes once an explicit preference is set", () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => result.current.setTheme("light"))

    act(() => mm.change(true))
    expect(result.current.resolvedTheme).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("useTheme throws when used outside a ThemeProvider", () => {
    // React logs the error it throws during render; silence it for a clean run.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => renderHook(() => useTheme())).toThrow(
      "useTheme must be used within a ThemeProvider",
    )
    spy.mockRestore()
  })
})
