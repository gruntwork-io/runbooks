import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { EXPIRY_WARNING_MS, useCredentialExpiry } from "../useCredentialExpiry"

const NOW = Date.parse("2026-10-03T12:00:00.000Z")
const MINUTE = 60_000

const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useCredentialExpiry", () => {
  it("has nothing to say about a credential without an expiry, or one that isn't a date", () => {
    expect(renderHook(() => useCredentialExpiry(undefined)).result.current).toBeUndefined()
    expect(renderHook(() => useCredentialExpiry("soon")).result.current).toBeUndefined()
  })

  it("is valid, then expiring for the last 5 minutes, then expired", () => {
    const { result } = renderHook(() => useCredentialExpiry(at(20 * MINUTE)))
    expect(result.current).toBe("valid")

    act(() => {
      vi.advanceTimersByTime(15 * MINUTE - 1)
    })
    expect(result.current).toBe("valid")
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe("expiring")

    act(() => {
      vi.advanceTimersByTime(EXPIRY_WARNING_MS - 1)
    })
    expect(result.current).toBe("expiring")
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe("expired")
  })

  it("starts expiring or expired for a credential already that close", () => {
    expect(renderHook(() => useCredentialExpiry(at(4 * MINUTE))).result.current).toBe("expiring")
    expect(renderHook(() => useCredentialExpiry(at(-MINUTE))).result.current).toBe("expired")
  })

  it("catches up with a new credential signed in long after the block mounted", () => {
    const { result, rerender } = renderHook(({ expiresAt }) => useCredentialExpiry(expiresAt), {
      initialProps: { expiresAt: undefined as string | undefined },
    })
    act(() => {
      vi.advanceTimersByTime(60 * MINUTE)
    })

    rerender({ expiresAt: at(62 * MINUTE) })
    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(result.current).toBe("expiring")
  })

  it("waits out a credential that expires months from now without firing early", () => {
    const { result } = renderHook(() => useCredentialExpiry(at(90 * 24 * 60 * MINUTE)))

    act(() => {
      vi.advanceTimersByTime(30 * 24 * 60 * MINUTE)
    })

    expect(result.current).toBe("valid")
  })
})
