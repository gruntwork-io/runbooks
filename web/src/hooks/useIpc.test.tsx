import { describe, it, expect, vi, afterEach } from "vitest"
import { createElement, useEffect, useRef, type ReactNode } from "react"
import { renderHook, act } from "@testing-library/react"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { makeTestApi, type Result } from "@/test/test-api"
import { renderedInline } from "@/test/render-inline"
import { useIpc, type UseIpcOptions, type UseIpcReturn } from "./useIpc"

// =============================================================================
// useIpc request sequencing, lazy/debounce and disabled transitions
// =============================================================================
//
// Mock boundary: the IPC API is the only fake (makeTestApi). Its invokes stay
// pending until the test settles them, so response ordering is under the
// test's control.
// `useApi()` is fed through the real ApiProvider.

// Each channel the tests drive holds its invokes, so the test settles them in
// any order.
function createControllableApi() {
  const testApi = makeTestApi()
  return {
    api: testApi.api,
    invoke: testApi.invoke,
    reads: testApi.hold("file:read"),
    renders: testApi.hold("boilerplate:render"),
    inlineRenders: testApi.hold("boilerplate:render-inline"),
  }
}

const file = (path: string, content: string): Result<"file:read"> => ({
  path,
  content,
  isBinary: false,
})
const A = file("a", "A")
const B = file("b", "B")
const RENDER_REQUEST = { templatePath: "/templates/vpc", variables: { v: 1 }, outputPath: "/out" }
const RENDERED: Result<"boilerplate:render"> = {
  message: "Template rendered to /out",
  outputDir: "/out",
  templatePath: "/templates/vpc",
  fileTree: [],
  totalFiles: 1,
  truncatedTree: false,
  heavyDirs: [],
  deletedFiles: [],
  createdFiles: ["main.tf"],
  modifiedFiles: [],
  skippedFiles: [],
}
const RENDERED_INLINE = renderedInline({ "main.tf": "rendered" })

interface HookProps {
  channel: string
  params?: unknown
  options?: UseIpcOptions
}

function renderUseIpc(api: RunbooksAPI, initialProps: HookProps) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ApiProvider, { api }, children)
  return renderHook(
    ({ channel, params, options }: HookProps) => useIpc<unknown>(channel, params, options),
    { initialProps, wrapper },
  )
}

/** Settle an invoke and let the hook's await continuation run inside act. */
async function settle(fn: () => void) {
  await act(async () => {
    fn()
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("useIpc", () => {
  describe("eager fetch", () => {
    it("fetches on mount and commits the response", async () => {
      const { api, invoke, reads } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: "file:read", params: { path: "a" } })

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith("file:read", { path: "a" })
      expect(result.current.isLoading).toBe(true)

      await settle(() => reads[0]!.resolve(A))

      expect(result.current.data).toBe(A)
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it("ignores an older response that resolves after a newer one", async () => {
      const { api, invoke, reads } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: "file:read",
        params: { path: "a" },
      })

      rerender({ channel: "file:read", params: { path: "b" } })
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(reads[1]!.params).toEqual({ path: "b" })

      await settle(() => reads[1]!.resolve(B))
      expect(result.current.data).toBe(B)

      await settle(() => reads[0]!.resolve(A))
      expect(result.current.data).toBe(B)
      expect(result.current.isLoading).toBe(false)
    })

    it("ignores an older rejection that settles after a newer response", async () => {
      const { api, reads } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: "file:read",
        params: { path: "a" },
      })

      rerender({ channel: "file:read", params: { path: "b" } })
      await settle(() => reads[1]!.resolve(B))
      await settle(() => reads[0]!.reject(new Error("stale failure")))

      expect(result.current.data).toBe(B)
      expect(result.current.error).toBeNull()
    })

    it("does not re-fetch when params change identity but not content", () => {
      const { api, invoke } = createControllableApi()
      const { rerender } = renderUseIpc(api, { channel: "file:read", params: { path: "a" } })

      rerender({ channel: "file:read", params: { path: "a" } })

      expect(invoke).toHaveBeenCalledTimes(1)
    })

    it("leaves state alone when the main process reports the call as superseded", async () => {
      const { api, renders } = createControllableApi()
      const { result } = renderUseIpc(api, {
        channel: "boilerplate:render",
        params: RENDER_REQUEST,
      })
      await settle(() => renders[0]!.resolve(RENDERED))

      act(() => result.current.refetch())
      expect(result.current.isLoading).toBe(true)
      await settle(() => renders[1]!.resolve({ superseded: true }))

      // Not committed as data; the newer call that superseded it drives state.
      expect(result.current.data).toBe(RENDERED)
      expect(result.current.error).toBeNull()
      expect(result.current.isLoading).toBe(true)
    })
  })

  describe("errors", () => {
    it("strips Electron's IPC wrapper and repeated Error: prefixes from the message", async () => {
      const { api, reads } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: "file:read", params: { path: "a" } })

      await settle(() =>
        reads[0]!.reject(new Error("Error invoking remote method 'file:read': Error: Error: boom")),
      )

      expect(result.current.error?.message).toBe("boom")
      expect(result.current.error?.details).toBe("boom")
      expect(result.current.isLoading).toBe(false)
    })

    it("reports a generic message for a non-Error rejection", async () => {
      const { api, reads } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: "file:read", params: { path: "a" } })

      await settle(() => reads[0]!.reject("not an Error"))

      expect(result.current.error?.message).toBe("An unexpected error occurred")
    })

    it("clears the error when a refetch succeeds", async () => {
      const { api, reads } = createControllableApi()
      const { result } = renderUseIpc(api, { channel: "file:read", params: { path: "a" } })
      await settle(() => reads[0]!.reject(new Error("boom")))
      expect(result.current.error).not.toBeNull()

      act(() => result.current.refetch())
      await settle(() => reads[1]!.resolve(A))

      expect(result.current.error).toBeNull()
      expect(result.current.data).toBe(A)
    })
  })

  describe("lazy + debouncedRequest", () => {
    const lazyOptions: UseIpcOptions = { lazy: true, debounceMs: 300 }

    it("does not fetch on mount", () => {
      const { api, invoke } = createControllableApi()
      const { result } = renderUseIpc(api, {
        channel: "boilerplate:render-inline",
        options: lazyOptions,
      })

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.isLoading).toBe(false)
    })

    it("collapses a burst of requests into one invoke with the last params", async () => {
      vi.useFakeTimers()
      const { api, invoke, inlineRenders } = createControllableApi()
      const { result } = renderUseIpc(api, {
        channel: "boilerplate:render-inline",
        options: lazyOptions,
      })

      act(() => result.current.debouncedRequest!({ variables: { v: 1 } }))
      act(() => {
        vi.advanceTimersByTime(100)
      })
      act(() => result.current.debouncedRequest!({ variables: { v: 2 } }))
      act(() => {
        vi.advanceTimersByTime(100)
      })
      act(() => result.current.debouncedRequest!({ variables: { v: 3 } }))
      act(() => {
        vi.advanceTimersByTime(299)
      })
      expect(invoke).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith("boilerplate:render-inline", { variables: { v: 3 } })
      expect(result.current.isLoading).toBe(true)

      await settle(() => inlineRenders[0]!.resolve(RENDERED_INLINE))
      expect(result.current.data).toBe(RENDERED_INLINE)
      expect(result.current.isLoading).toBe(false)
    })

    it("sends nothing when the hook unmounts before the debounce delay elapses", () => {
      vi.useFakeTimers()
      const { api, invoke } = createControllableApi()
      const { result, unmount } = renderUseIpc(api, {
        channel: "boilerplate:render-inline",
        options: lazyOptions,
      })

      act(() => result.current.debouncedRequest!({ variables: { v: 1 } }))
      unmount()
      act(() => {
        vi.advanceTimersByTime(1000)
      })

      expect(invoke).not.toHaveBeenCalled()
    })

    it("keeps existing data when params change (the consumer drives fetches)", async () => {
      vi.useFakeTimers()
      const { api, invoke, inlineRenders } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: "boilerplate:render-inline",
        params: { variables: { v: 1 } },
        options: lazyOptions,
      })
      act(() => result.current.debouncedRequest!({ variables: { v: 1 } }))
      act(() => {
        vi.advanceTimersByTime(300)
      })
      await settle(() => inlineRenders[0]!.resolve(RENDERED_INLINE))

      rerender({
        channel: "boilerplate:render-inline",
        params: { variables: { v: 2 } },
        options: lazyOptions,
      })

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(result.current.data).toBe(RENDERED_INLINE)
    })
  })

  // StrictMode (main.tsx wraps the app in it) and Fast Refresh run every effect
  // cleanup and then every setup again on a live component. A consumer that
  // issues its first request from a mount effect, guarded by a ref so the
  // re-run doesn't repeat it, must still see that request go out and land.
  describe("StrictMode effect re-run", () => {
    function renderStrict(api: RunbooksAPI, useConsumer: () => UseIpcReturn<unknown>) {
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(ApiProvider, { api }, children)
      return renderHook(useConsumer, { wrapper, reactStrictMode: true })
    }

    it("still sends a debounced request scheduled from a mount effect", async () => {
      vi.useFakeTimers()
      const { api, invoke, inlineRenders } = createControllableApi()
      const { result } = renderStrict(api, () => {
        const ipc = useIpc<unknown>("boilerplate:render-inline", undefined, {
          lazy: true,
          debounceMs: 300,
        })
        const sentRef = useRef(false)
        const { debouncedRequest } = ipc
        useEffect(() => {
          if (sentRef.current) return
          sentRef.current = true
          debouncedRequest!({ variables: { v: 1 } })
        }, [debouncedRequest])
        return ipc
      })

      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith("boilerplate:render-inline", { variables: { v: 1 } })

      await settle(() => inlineRenders[0]!.resolve(RENDERED_INLINE))
      expect(result.current.data).toBe(RENDERED_INLINE)
      expect(result.current.isLoading).toBe(false)
    })

    it("still commits a request started from a mount effect", async () => {
      const { api, invoke, inlineRenders } = createControllableApi()
      const { result } = renderStrict(api, () => {
        const ipc = useIpc<unknown>(
          "boilerplate:render-inline",
          { variables: { v: 1 } },
          { lazy: true },
        )
        const sentRef = useRef(false)
        const { refetch } = ipc
        useEffect(() => {
          if (sentRef.current) return
          sentRef.current = true
          refetch()
        }, [refetch])
        return ipc
      })

      expect(invoke).toHaveBeenCalledTimes(1)
      await settle(() => inlineRenders[0]!.resolve(RENDERED_INLINE))

      expect(result.current.data).toBe(RENDERED_INLINE)
      expect(result.current.isLoading).toBe(false)
    })
  })

  describe("disabled / cleared channel", () => {
    it("does not fetch while disabled", () => {
      const { api, invoke } = createControllableApi()
      const { result } = renderUseIpc(api, {
        channel: "file:read",
        params: { path: "a" },
        options: { disabled: true },
      })

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.isLoading).toBe(false)
      expect(result.current.data).toBeNull()
    })

    it("fetches once it goes from disabled to enabled", async () => {
      const { api, invoke, reads } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: "file:read",
        params: { path: "a" },
        options: { disabled: true },
      })

      rerender({ channel: "file:read", params: { path: "a" }, options: { disabled: false } })

      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith("file:read", { path: "a" })
      expect(result.current.isLoading).toBe(true)
      await settle(() => reads[0]!.resolve(A))
      expect(result.current.data).toBe(A)
    })

    it("clears data and error when disabled", async () => {
      const { api, reads } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: "file:read",
        params: { path: "a" },
      })
      await settle(() => reads[0]!.resolve(A))

      rerender({ channel: "file:read", params: { path: "a" }, options: { disabled: true } })

      expect(result.current.data).toBeNull()
      expect(result.current.error).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })

    it("drops an in-flight response that settles after the channel is cleared", async () => {
      const { api, reads } = createControllableApi()
      const { result, rerender } = renderUseIpc(api, {
        channel: "file:read",
        params: { path: "a" },
      })

      rerender({ channel: "", params: { path: "a" } })
      await settle(() => reads[0]!.resolve(A))

      expect(result.current.data).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })

    it("cancels a pending debounced request when disabled", () => {
      vi.useFakeTimers()
      const { api, invoke } = createControllableApi()
      const options: UseIpcOptions = { lazy: true, debounceMs: 300 }
      const { result, rerender } = renderUseIpc(api, { channel: "boilerplate:render", options })

      act(() => result.current.debouncedRequest!(RENDER_REQUEST))
      rerender({ channel: "boilerplate:render", options: { ...options, disabled: true } })
      act(() => {
        vi.advanceTimersByTime(1000)
      })

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.data).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })

    it("cancels a pending debounced request when the channel is cleared", () => {
      vi.useFakeTimers()
      const { api, invoke } = createControllableApi()
      const options: UseIpcOptions = { lazy: true, debounceMs: 300 }
      const { result, rerender } = renderUseIpc(api, { channel: "boilerplate:render", options })

      act(() => result.current.debouncedRequest!(RENDER_REQUEST))
      // The timer holds the performInvoke captured with the old channel, so
      // only clearing the timer (not bumping the request seq) stops it.
      rerender({ channel: "", options })
      act(() => {
        vi.advanceTimersByTime(1000)
      })

      expect(invoke).not.toHaveBeenCalled()
      expect(result.current.data).toBeNull()
      expect(result.current.isLoading).toBe(false)
    })
  })
})
