import { describe, it, expect } from "bun:test"
import {
  compareVersions,
  extractVersion,
  parseConstraint,
  parseVersion,
  satisfiesConstraint,
} from "./version.ts"

/** Whether `version` meets `constraint`, failing the test if either doesn't parse. */
function meets(version: string, constraint: string): boolean {
  const parsed = parseConstraint(constraint)
  if (!parsed.ok) throw new Error(parsed.error)
  return satisfiesConstraint(parseVersion(version)!, parsed.constraint)
}

describe("extractVersion", () => {
  it.each([
    ["git version 2.54.0 (Apple Git-157)", "2.54.0"],
    ["OpenTofu v1.8.2\non darwin_arm64", "1.8.2"],
    ["terragrunt version v0.67.4", "0.67.4"],
    ["aws-cli/2.15.0 Python/3.11.6 Darwin/23.3.0 exe/x86_64", "2.15.0"],
    ['openjdk version "21.0.1" 2023-10-17', "21.0.1"],
    ["GNU bash, version 5.2.37(1)-release (aarch64-apple-darwin24.0.0)", "5.2.37"],
    ["Client Version: v1.29.1-eks-508b6b3", "1.29.1"],
    ["jq-1.7.1", "1.7.1"],
    ["go version go1.22.1 darwin/arm64", "1.22.1"],
    ["1.2.553.0", "1.2.553.0"],
  ])("reads %j as %s", (output, version) => {
    expect(extractVersion(output)).toBe(version)
  })

  it("finds nothing in output without a dotted number", () => {
    expect(extractVersion("usage: tool [options]\nbuilt 2024-01-01")).toBeNull()
    expect(extractVersion("")).toBeNull()
  })
})

describe("parseVersion", () => {
  it("reads numbers separated by dots, with or without a leading v", () => {
    expect(parseVersion("1.6")).toEqual([1, 6])
    expect(parseVersion("v1.6.2")).toEqual([1, 6, 2])
    expect(parseVersion(" 2 ")).toEqual([2])
  })

  it("refuses anything else", () => {
    for (const text of ["", "1.x", "1.6-beta1", "latest", "1..2", ">= 1"]) {
      expect(parseVersion(text)).toBeNull()
    }
  })
})

describe("compareVersions", () => {
  it("compares number by number, a missing number counting as 0", () => {
    expect(compareVersions([1, 10], [1, 9])).toBe(1)
    expect(compareVersions([1, 6], [1, 6, 0])).toBe(0)
    expect(compareVersions([1, 6], [1, 6, 1])).toBe(-1)
    expect(compareVersions([2], [1, 99, 99])).toBe(1)
  })
})

describe("parseConstraint", () => {
  it("reads comma-separated conditions, with or without spaces", () => {
    const parsed = parseConstraint(">=1.6, < 2.0")
    expect(parsed).toEqual({
      ok: true,
      constraint: {
        conditions: [
          { operator: ">=", version: [1, 6] },
          { operator: "<", version: [2, 0] },
        ],
      },
    })
  })

  it("reads a bare version as an exact one", () => {
    expect(parseConstraint("1.6.0")).toEqual({
      ok: true,
      constraint: { conditions: [{ operator: "=", version: [1, 6, 0] }] },
    })
  })

  it("says which condition it couldn't read", () => {
    expect(parseConstraint(">= 1.6, latest")).toEqual({
      ok: false,
      error: `"latest" isn't a version condition such as ">= 1.6" or "~> 1.6"`,
    })
    expect(parseConstraint("=> 1.6")).toMatchObject({ ok: false })
    expect(parseConstraint(">= 1.6-beta1")).toMatchObject({ ok: false })
    expect(parseConstraint(">= 1.6,")).toEqual({
      ok: false,
      error: `">= 1.6," has an empty condition`,
    })
  })
})

describe("satisfiesConstraint", () => {
  it.each([
    ["1.6.0", "1.6", true],
    ["1.6.1", "= 1.6", false],
    ["1.6.1", "!= 1.6", true],
    ["1.7", "> 1.6", true],
    ["1.6", "> 1.6", false],
    ["1.6", ">= 1.6", true],
    ["1.5.9", ">= 1.6", false],
    ["1.9", "< 2", true],
    ["2.0", "< 2", false],
    ["2.0", "<= 2", true],
    ["1.10.0", ">= 1.6, < 2.0", true],
    ["2.0.0", ">= 1.6, < 2.0", false],
  ])("%s against %s: %p", (version, constraint, expected) => {
    expect(meets(version, constraint)).toBe(expected)
  })

  it("~> lets only the last number of its version go up", () => {
    expect(meets("1.6", "~> 1.6")).toBe(true)
    expect(meets("1.10", "~> 1.6")).toBe(true)
    expect(meets("2.0", "~> 1.6")).toBe(false)
    expect(meets("1.5", "~> 1.6")).toBe(false)

    expect(meets("1.6.9", "~> 1.6.2")).toBe(true)
    expect(meets("1.6.1", "~> 1.6.2")).toBe(false)
    expect(meets("1.7.0", "~> 1.6.2")).toBe(false)

    // With a single number there's nothing to keep, as in OpenTofu.
    expect(meets("3.1", "~> 1")).toBe(true)
  })
})
