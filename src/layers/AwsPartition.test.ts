import { describe, it, expect } from "bun:test"
import { partition } from "@aws-sdk/util-endpoints"
import { partitionHomeRegion } from "./AwsPartition.ts"

/** A region from each partition the SDK knows, with that partition's home region. */
const SAMPLES: ReadonlyArray<readonly [partitionName: string, region: string, home: string]> = [
  ["aws", "eu-west-2", "us-east-1"],
  ["aws-us-gov", "us-gov-east-1", "us-gov-west-1"],
  ["aws-cn", "cn-north-1", "cn-northwest-1"],
  ["aws-eusc", "eusc-de-east-1", "eusc-de-east-1"],
  ["aws-iso", "us-iso-west-1", "us-iso-east-1"],
  ["aws-iso-b", "us-isob-west-1", "us-isob-east-1"],
  ["aws-iso-e", "eu-isoe-west-1", "eu-isoe-west-1"],
  ["aws-iso-f", "us-isof-east-1", "us-isof-south-1"],
]

describe("partitionHomeRegion", () => {
  it.each(SAMPLES)("maps %s (%s) to its home region %s", (_name, region, home) => {
    expect(partitionHomeRegion(region)).toBe(home)
  })

  it.each(SAMPLES)("keeps %s credentials in their own partition", (name, region) => {
    expect(partition(region).name).toBe(name)
    expect(partition(partitionHomeRegion(region)).name).toBe(name)
  })

  it("maps every commercial region to us-east-1", () => {
    for (const region of ["us-east-1", "us-west-2", "ap-southeast-4", "me-central-1", "il-central-1"]) {
      expect(partitionHomeRegion(region)).toBe("us-east-1")
    }
  })

  it("treats an empty or unknown region as commercial, as the SDK does", () => {
    expect(partitionHomeRegion("")).toBe("us-east-1")
    expect(partitionHomeRegion("xx-nowhere-1")).toBe("us-east-1")
  })

  // partitionHomeRegion reads a field the SDK's published type omits. If an
  // upgrade drops it, this fails instead of every partition silently falling
  // back to the working region.
  it.each(SAMPLES)("gets %s's home region from the SDK's partition data", (_name, region, home) => {
    expect((partition(region) as { implicitGlobalRegion?: string }).implicitGlobalRegion).toBe(home)
  })
})
