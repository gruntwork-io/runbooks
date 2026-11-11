import { describe, it, expect } from "bun:test"
import { renderedUnit } from "./render.ts"

describe("renderedUnit", () => {
  it("reads the unit's source and inputs", () => {
    expect(
      renderedUnit({
        terraform: { source: "git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0" },
        inputs: { name: "platform" },
      }),
    ).toEqual({
      source: "git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0",
      inputs: { name: "platform" },
    })
  })

  it("reads a terraform block given as a list of one", () => {
    expect(renderedUnit({ terraform: [{ source: "../modules/x" }] }).source).toBe("../modules/x")
  })

  it("has no source for a unit that sets none", () => {
    expect(renderedUnit({ inputs: { a: 1 } })).toEqual({ inputs: { a: 1 } })
    expect(renderedUnit(null)).toEqual({ inputs: {} })
  })
})
