import { describe, it, expect } from "bun:test"
import { errorMessage } from "./message.ts"

describe("errorMessage", () => {
  it("returns an Error's message without its name", () => {
    expect(errorMessage(new TypeError("fetch failed"))).toBe("fetch failed")
  })

  it("returns a thrown string as is", () => {
    expect(errorMessage("boom")).toBe("boom")
  })

  it("JSON-encodes a thrown object instead of printing [object Object]", () => {
    expect(errorMessage({ code: "ENOENT" })).toBe('{"code":"ENOENT"}')
  })

  it("names an object that cannot be encoded", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe("unserializable error")
  })

  it("stringifies other primitives", () => {
    expect(errorMessage(undefined)).toBe("undefined")
    expect(errorMessage(42)).toBe("42")
  })
})
