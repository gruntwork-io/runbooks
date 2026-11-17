import { describe, it, expect, vi } from "vitest"
import { makeTestApi } from "./test-api"

const FILE = { path: "/a.sh", content: "echo a", isBinary: false }

describe("makeTestApi", () => {
  describe("invoke", () => {
    it("answers with the handler's result, given the call's params", async () => {
      const read = vi.fn(({ path }: { path: string }) => ({ ...FILE, path }))
      const { api } = makeTestApi({ "file:read": read })

      await expect(api.invoke("file:read", { path: "/b.sh" })).resolves.toEqual({
        ...FILE,
        path: "/b.sh",
      })
      expect(read).toHaveBeenCalledWith({ path: "/b.sh" })
    })

    it("answers with what an async handler resolves", async () => {
      const { api } = makeTestApi({ "file:read": async () => FILE })

      await expect(api.invoke("file:read", { path: "/a.sh" })).resolves.toEqual(FILE)
    })

    it("rejects an invoke of a channel with no handler, and lists it as unhandled", async () => {
      const testApi = makeTestApi({ "file:read": () => FILE })

      await expect(testApi.api.invoke("session:get")).rejects.toThrow(
        "makeTestApi: no handler for session:get",
      )
      expect(testApi.unhandled).toEqual(["session:get"])
    })

    it("rejects an invoke whose handler throws, as a throw in main does", async () => {
      const { api } = makeTestApi({
        "file:read": () => {
          throw new Error("ENOENT")
        },
      })

      const invoked = api.invoke("file:read", { path: "/gone" })

      expect(invoked).toBeInstanceOf(Promise)
      await expect(invoked).rejects.toThrow("ENOENT")
    })

    it("rejects an invoke whose async handler rejects", async () => {
      const { api } = makeTestApi({ "file:read": () => Promise.reject(new Error("EACCES")) })

      await expect(api.invoke("file:read", { path: "/a.sh" })).rejects.toThrow("EACCES")
    })

    it("answers with a handler set or replaced after creation", async () => {
      const testApi = makeTestApi({ "file:read": () => FILE })
      testApi.handle("file:read", () => ({ ...FILE, content: "echo b" }))
      testApi.handle("session:reset", () => ({ ok: true }))

      await expect(testApi.api.invoke("file:read", { path: "/a.sh" })).resolves.toMatchObject({
        content: "echo b",
      })
      await expect(testApi.api.invoke("session:reset")).resolves.toEqual({ ok: true })
    })

    it("gives a channel without params an undefined", async () => {
      const reset = vi.fn(() => ({ ok: true as const }))
      const { api } = makeTestApi({ "session:reset": reset })

      await api.invoke("session:reset")

      expect(reset).toHaveBeenCalledWith(undefined)
    })
  })

  describe("recorded calls", () => {
    it("records every invoke in order, answered or not", async () => {
      const testApi = makeTestApi({ "file:read": () => FILE })

      await testApi.api.invoke("file:read", { path: "/a.sh" })
      await testApi.api.invoke("session:reset").catch(() => {})
      await testApi.api.invoke("file:read", { path: "/b.sh" })

      expect(testApi.calls).toEqual([
        { channel: "file:read", params: { path: "/a.sh" } },
        { channel: "session:reset", params: undefined },
        { channel: "file:read", params: { path: "/b.sh" } },
      ])
    })

    it("lists one channel's params, typed by the channel", async () => {
      const testApi = makeTestApi({
        "file:read": () => FILE,
        "session:reset": () => ({ ok: true }),
      })

      await testApi.api.invoke("file:read", { path: "/a.sh" })
      await testApi.api.invoke("session:reset")
      await testApi.api.invoke("file:read", { path: "/b.sh" })

      expect(testApi.callsTo("file:read").map(({ path }) => path)).toEqual(["/a.sh", "/b.sh"])
      expect(testApi.callsTo("session:reset")).toHaveLength(1)
      expect(testApi.callsTo("session:get")).toEqual([])
    })

    it("calls the invoke spy with the arguments api.invoke got", async () => {
      const testApi = makeTestApi({
        "file:read": () => FILE,
        "session:reset": () => ({ ok: true }),
      })

      await testApi.api.invoke("file:read", { path: "/a.sh" })
      await testApi.api.invoke("session:reset")

      expect(testApi.invoke).toHaveBeenCalledWith("file:read", { path: "/a.sh" })
      expect(testApi.invoke.mock.calls[1]).toEqual(["session:reset"])
    })
  })

  describe("hold", () => {
    it("keeps each invoke pending until the test settles it, in any order", async () => {
      const testApi = makeTestApi()
      const reads = testApi.hold("file:read")

      const first = testApi.api.invoke("file:read", { path: "/1" })
      const second = testApi.api.invoke("file:read", { path: "/2" })
      const settled: string[] = []
      void first.then(
        () => settled.push("first"),
        () => settled.push("first rejected"),
      )
      void second.then(() => settled.push("second"))

      expect(reads.map((call) => call.params.path)).toEqual(["/1", "/2"])
      await Promise.resolve()
      expect(settled).toEqual([])

      reads[1]!.resolve({ ...FILE, path: "/2" })
      await expect(second).resolves.toMatchObject({ path: "/2" })
      expect(settled).toEqual(["second"])

      reads[0]!.reject(new Error("aborted"))
      await expect(first).rejects.toThrow("aborted")
      expect(settled).toEqual(["second", "first rejected"])
    })

    it("replaces the channel's handler", async () => {
      const testApi = makeTestApi({ "file:read": () => FILE })
      const reads = testApi.hold("file:read")

      const read = testApi.api.invoke("file:read", { path: "/a.sh" })
      reads[0]!.resolve({ ...FILE, content: "held" })

      await expect(read).resolves.toMatchObject({ content: "held" })
    })
  })

  describe("events", () => {
    const LOG = { executionId: "run-1", line: "hello", timestamp: "2024-01-01T00:00:00Z" }

    it("calls each callback subscribed to the channel with the payload", () => {
      const testApi = makeTestApi()
      const first = vi.fn()
      const second = vi.fn()
      const other = vi.fn()
      testApi.api.on("exec:log", first)
      testApi.api.on("exec:log", second)
      testApi.api.on("exec:log-file", other)

      testApi.emit("exec:log", LOG)

      expect(first).toHaveBeenCalledWith(LOG)
      expect(second).toHaveBeenCalledWith(LOG)
      expect(other).not.toHaveBeenCalled()
    })

    it("emits an event without a payload", () => {
      const testApi = makeTestApi()
      const updated = vi.fn()
      testApi.api.on("registry:updated", updated)

      testApi.emit("registry:updated")

      expect(updated).toHaveBeenCalledTimes(1)
    })

    it("stops calling a callback once it unsubscribes", () => {
      const testApi = makeTestApi()
      const callback = vi.fn()
      const unsubscribe = testApi.api.on("exec:log", callback)
      expect(testApi.listenerCount("exec:log")).toBe(1)

      unsubscribe()
      testApi.emit("exec:log", LOG)

      expect(callback).not.toHaveBeenCalled()
      expect(testApi.listenerCount("exec:log")).toBe(0)
    })

    it("calls every callback subscribed when it was sent, though one unsubscribes another", () => {
      const testApi = makeTestApi()
      const later = vi.fn()
      testApi.api.on("exec:log", () => unsubscribeLater())
      const unsubscribeLater = testApi.api.on("exec:log", later)

      testApi.emit("exec:log", LOG)
      testApi.emit("exec:log", LOG)

      expect(later).toHaveBeenCalledTimes(1)
      expect(testApi.listenerCount("exec:log")).toBe(1)
    })

    it("calls the on spy with the arguments api.on got", () => {
      const testApi = makeTestApi()
      const callback = vi.fn()

      testApi.api.on("exec:log", callback)

      expect(testApi.on).toHaveBeenCalledWith("exec:log", callback)
    })
  })

  // Checked by typecheck, not at runtime: each @ts-expect-error must have an error under it.
  it("rejects stubs and events of the wrong shape at typecheck", () => {
    // Separate objects: TypeScript reports a key it doesn't know only when the
    // object's other keys are fine.
    // @ts-expect-error: no such channel
    makeTestApi({ "file:get": () => "A" })
    const testApi = makeTestApi({
      // @ts-expect-error: file:read answers with FileData, which has content
      "file:read": () => ({ path: "/a.sh", isBinary: false }),
      // @ts-expect-error: session:rename's params have a name, not a title
      "session:rename": ({ title }: { title: string }) => ({ name: title }),
    })
    // @ts-expect-error: session:reset answers { ok: true }
    testApi.handle("session:reset", () => ({ ok: false }))
    // @ts-expect-error: exec:log's payload needs its executionId
    testApi.emit("exec:log", { line: "a", timestamp: "t" })
    // @ts-expect-error: registry:updated carries nothing
    testApi.emit("registry:updated", { reason: "x" })
    // @ts-expect-error: session:delete takes params
    void testApi.api.invoke("session:delete").catch(() => {})
    expect(testApi.unhandled).toEqual(["session:delete"])
  })
})
