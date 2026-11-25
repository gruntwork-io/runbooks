import { describe, expect, it } from "bun:test"
import { registryProblems } from "@runbooks/blocks-core/registry"
import * as registry from "./index.ts"

describe("the registry", () => {
  it("files each entry under its own tag, and each alias under a block", () => {
    expect(registryProblems(registry)).toEqual([])
  })
})
