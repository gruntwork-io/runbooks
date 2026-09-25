import { describe, it, expect } from "bun:test"
import { partitionHomeRegion } from "./partition.ts"

describe("partitionHomeRegion", () => {
  it("maps commercial regions to us-east-1", () => {
    expect(partitionHomeRegion("us-east-1")).toBe("us-east-1")
    expect(partitionHomeRegion("eu-west-2")).toBe("us-east-1")
    expect(partitionHomeRegion("ap-southeast-4")).toBe("us-east-1")
  })

  it("maps GovCloud regions to us-gov-west-1", () => {
    expect(partitionHomeRegion("us-gov-west-1")).toBe("us-gov-west-1")
    expect(partitionHomeRegion("us-gov-east-1")).toBe("us-gov-west-1")
  })

  it("treats an empty region as commercial", () => {
    expect(partitionHomeRegion("")).toBe("us-east-1")
  })
})
