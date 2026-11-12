import { describe, it, expect } from "vitest"
import type { TfModuleVariable } from "../../../../../../src/domain/tf-module/types"
import { fieldError, unitPath } from "../lib"

describe("fieldError", () => {
  it("checks a list's count against length(), not each item's length", () => {
    const owners: TfModuleVariable = {
      name: "owners",
      label: "Owners",
      description: "",
      tfType: "list(string)",
      kind: "list",
      hasDefault: false,
      sensitive: false,
      primary: true,
      checks: [{ kind: "count", min: 1, max: 2, message: "One or two owners." }],
    }
    expect(fieldError(owners, ["alice@example.com"])).toBeUndefined()
    expect(fieldError(owners, ["a@example.com", "b@example.com", "c@example.com"])).toBe(
      "One or two owners.",
    )
  })
})

describe("unitPath", () => {
  it("puts the code at the block's path, or under its id", () => {
    const values = { id: "team@example.com" }
    expect(unitPath("groups/{{ .id }}", "group", values)).toBe("groups/team@example.com")
    expect(unitPath(undefined, "group", values)).toBe("group")
  })
})
