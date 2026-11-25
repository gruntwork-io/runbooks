import { describe, expect, it } from "bun:test"
import { versionProblem } from "./runbooksVersion.ts"

describe("versionProblem", () => {
  it.each([
    [">= 0.28", "0.28.0"],
    [">= 0.28", "1.0.0"],
    ["~> 0.28", "0.31.2"],
    [">= 0.28, < 1", "0.29.0"],
    // A pre-release or build counts as its release.
    [">= 0.28", "0.28.0-rc.1"],
    // A version that isn't numbers, which no release has, meets any requirement.
    [">= 0.28", "dev"],
  ])("is undefined when %s is met by %s", (requirement, version) => {
    expect(versionProblem(requirement, version)).toBeUndefined()
  })

  it("says which version the runbook needs, and to update, when this one is too old", () => {
    expect(versionProblem(">= 0.29", "0.28.0")).toBe(
      "This runbook needs Runbooks >= 0.29, and this is Runbooks 0.28.0. Update Runbooks to use it.",
    )
    expect(versionProblem("~> 0.29.2", "0.29.1")).toContain("Update Runbooks")
    expect(versionProblem("> 0.28", "0.28.0")).toContain("Update Runbooks")
  })

  it("doesn't say to update when a later version wouldn't meet the requirement either", () => {
    expect(versionProblem("< 0.28", "0.28.0")).toBe(
      "This runbook needs Runbooks < 0.28, and this is Runbooks 0.28.0.",
    )
    expect(versionProblem("~> 0.28", "1.0.0")).not.toContain("Update")
    expect(versionProblem("!= 0.28.0", "0.28.0")).not.toContain("Update")
  })

  it("reports a requirement it can't read", () => {
    expect(versionProblem(0.3, "0.28.0")).toBe(
      'Quote the version of Runbooks in the front matter, as in runbooks: ">= 0.28". YAML reads an unquoted 0.30 as the number 0.3.',
    )
    expect(versionProblem([0.28], "0.28.0")).toBe(
      '`runbooks` in the front matter must be text, such as runbooks: ">= 0.28".',
    )
    expect(versionProblem("newest", "0.28.0")).toBe(
      '`runbooks` in the front matter isn\'t a version of Runbooks: "newest" isn\'t a version condition such as ">= 1.6" or "~> 1.6".',
    )
  })
})
