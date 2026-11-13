import { describe, expect, it } from "bun:test"
import { loadGoWasm } from "./goWasmGlobal.ts"

describe("loadGoWasm", () => {
  it("starts a load only after the one before it has settled, even when it failed", async () => {
    const events: string[] = []
    let finishFirst!: () => void
    const first = loadGoWasm(
      () =>
        new Promise<void>((_, reject) => {
          events.push("first start")
          finishFirst = () => {
            events.push("first end")
            reject(new Error("boom"))
          }
        }),
    )
    const second = loadGoWasm(async () => {
      events.push("second start")
      return "second"
    })

    await Promise.resolve()
    expect(events).toEqual(["first start"])
    finishFirst()

    await expect(first).rejects.toThrow("boom")
    expect(await second).toBe("second")
    expect(events).toEqual(["first start", "first end", "second start"])
  })
})
