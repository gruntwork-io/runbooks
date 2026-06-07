import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ReactNode } from "react"
import { ComponentIdRegistryProvider, useComponentIdRegistry } from "./ComponentIdRegistry"

function wrapper({ children }: { children: ReactNode }) {
  return <ComponentIdRegistryProvider>{children}</ComponentIdRegistryProvider>
}

// Wait for the setTimeout(0) registration in the hook to fire.
async function flushRegistration() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
}

describe("ComponentIdRegistry", () => {
  it("registers without showing duplicate for a unique ID", async () => {
    const { result } = renderHook(() => useComponentIdRegistry("my-block", "Command"), { wrapper })

    await flushRegistration()

    expect(result.current.isDuplicate).toBe(false)
    expect(result.current.isNormalizedCollision).toBe(false)
    expect(result.current.collidingId).toBeUndefined()
  })

  it("detects exact duplicate IDs", async () => {
    // Render two components with the same ID
    function useBoth() {
      const a = useComponentIdRegistry("same-id", "Command")
      const b = useComponentIdRegistry("same-id", "Check")
      return { a, b }
    }

    const { result } = renderHook(() => useBoth(), { wrapper })

    await flushRegistration()

    // At least one should detect the duplicate
    const aDup = result.current.a.isDuplicate
    const bDup = result.current.b.isDuplicate
    expect(aDup || bDup).toBe(true)
  })

  it("detects normalized collisions (hyphens vs underscores)", async () => {
    function useBoth() {
      const a = useComponentIdRegistry("create-account", "Command")
      const b = useComponentIdRegistry("create_account", "Check")
      return { a, b }
    }

    const { result } = renderHook(() => useBoth(), { wrapper })

    await flushRegistration()

    const aDup = result.current.a.isDuplicate
    const bDup = result.current.b.isDuplicate
    expect(aDup || bDup).toBe(true)

    // The one that detects the collision should report isNormalizedCollision
    if (aDup) {
      expect(result.current.a.isNormalizedCollision).toBe(true)
      expect(result.current.a.collidingId).toBe("create_account")
    }
    if (bDup) {
      expect(result.current.b.isNormalizedCollision).toBe(true)
      expect(result.current.b.collidingId).toBe("create-account")
    }
  })

  it("does not false-positive on different IDs", async () => {
    function useBoth() {
      const a = useComponentIdRegistry("alpha", "Command")
      const b = useComponentIdRegistry("beta", "Command")
      return { a, b }
    }

    const { result } = renderHook(() => useBoth(), { wrapper })

    await flushRegistration()

    expect(result.current.a.isDuplicate).toBe(false)
    expect(result.current.b.isDuplicate).toBe(false)
  })

  it("works without provider (returns safe defaults)", () => {
    const { result } = renderHook(() => useComponentIdRegistry("test", "Command"))

    expect(result.current.isDuplicate).toBe(false)
    expect(result.current.isNormalizedCollision).toBe(false)
  })
})
