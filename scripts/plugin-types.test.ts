import { describe, expect, it } from "bun:test"
import { outdated } from "./plugin-types.ts"

describe("plugin protocol types", () => {
  it("are generated from the current JSON Schema files", () => {
    expect(outdated()).toEqual([])
  })
})
