import { describe, it, expect } from "bun:test"
import { inputsKey } from "./inputsKey.ts"

describe("inputsKey", () => {
  it("is the same for equal values in any key order, and differs for other values", () => {
    expect(inputsKey({ a: 1, b: { c: 2, d: [3] } })).toBe(inputsKey({ b: { d: [3], c: 2 }, a: 1 }))
    expect(inputsKey({ a: 1 })).not.toBe(inputsKey({ a: 2 }))
  })
})
