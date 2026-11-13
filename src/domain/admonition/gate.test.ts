import { describe, expect, it } from "bun:test"
import { gateProblem } from "./gate.ts"

describe("gateProblem", () => {
  it("accepts an id and confirmationText", () => {
    expect(gateProblem({ id: "mail", confirmationText: "It arrived" })).toBeNull()
  })

  it("needs a non-empty id", () => {
    expect(gateProblem({ id: "", confirmationText: "It arrived" })).toBe("needs a non-empty id.")
  })

  it("needs confirmationText", () => {
    expect(gateProblem({ id: "mail" })).toContain("needs confirmationText")
    expect(gateProblem({ id: "mail", confirmationText: "" })).toContain("needs confirmationText")
  })

  it("refuses closable and allowPermanentHide", () => {
    expect(gateProblem({ id: "mail", confirmationText: "Ok", closable: true })).toContain(
      "can't be closable",
    )
    expect(gateProblem({ id: "mail", confirmationText: "Ok", allowPermanentHide: true })).toContain(
      "can't use allowPermanentHide",
    )
  })

  it("allows closable={false}", () => {
    expect(gateProblem({ id: "mail", confirmationText: "Ok", closable: false })).toBeNull()
  })
})
