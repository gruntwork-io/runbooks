import { describe, it, expect } from "vitest"
import { unitPath } from "../lib"

describe("unitPath", () => {
  it("puts the code at the block's path, or under its id", () => {
    const values = { id: "team@example.com" }
    expect(unitPath("groups/{{ .id }}", "group", values)).toBe("groups/team@example.com")
    expect(unitPath(undefined, "group", values)).toBe("group")
  })
})
