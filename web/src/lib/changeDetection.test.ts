import { describe, it, expect } from "vitest"
import { computeChangeKey } from "./changeDetection"

describe("computeChangeKey", () => {
  it("ignores object key order at any depth", () => {
    expect(computeChangeKey({ tags: { a: 1, b: 2 } }, [{ x: 1, y: 2 }])).toBe(
      computeChangeKey({ tags: { b: 2, a: 1 } }, [{ y: 2, x: 1 }]),
    )
  })

  it("keeps array order", () => {
    expect(computeChangeKey(["a", "b"])).not.toBe(computeChangeKey(["b", "a"]))
  })

  it("changes when a value changes", () => {
    expect(computeChangeKey({ region: "us-east-1" })).not.toBe(
      computeChangeKey({ region: "eu-west-1" }),
    )
  })
})
