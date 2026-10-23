import { describe, it, expect } from "bun:test"
import pkg from "../package.json" with { type: "json" }
import {
  RUNBOOKS_VERSION,
  unknownBlocks,
  unknownBlocksError,
  versionRequirementError,
} from "./runbooks-version.ts"

/** A runbook whose front matter is the lines `frontMatter`. */
function runbook(...frontMatter: string[]): string {
  return ["---", ...frontMatter, "---", "", "# Runbook", ""].join("\n")
}

describe("RUNBOOKS_VERSION", () => {
  it("is the version in package.json, which a release sets", () => {
    expect(RUNBOOKS_VERSION).toBe(pkg.version)
  })
})

describe("versionRequirementError", () => {
  it("is null for a runbook without front matter, or without a requirement in it", () => {
    expect(versionRequirementError("# Runbook\n", "0.28.0")).toBeNull()
    expect(versionRequirementError(runbook("title: Deploy"), "0.28.0")).toBeNull()
    expect(versionRequirementError(runbook("- a list"), "0.28.0")).toBeNull()
  })

  it.each([
    [">= 0.28", "0.28.0"],
    [">= 0.28", "1.0.0"],
    ["~> 0.28", "0.31.2"],
    [">= 0.28, < 1", "0.29.0"],
    // A pre-release or build counts as its release.
    [">= 0.28", "0.28.0-rc.1"],
  ])("is null when %s is met by %s", (requirement, version) => {
    expect(versionRequirementError(runbook(`runbooks: "${requirement}"`), version)).toBeNull()
  })

  it("says which version the runbook needs, and to update, when this one is too old", () => {
    expect(versionRequirementError(runbook('runbooks: ">= 0.29"'), "0.28.0")).toBe(
      "This runbook needs Runbooks >= 0.29, and this is Runbooks 0.28.0. Update Runbooks to use it.",
    )
    expect(versionRequirementError(runbook('runbooks: "~> 0.29.2"'), "0.29.1")).toContain(
      "Update Runbooks",
    )
    expect(versionRequirementError(runbook('runbooks: "> 0.28"'), "0.28.0")).toContain(
      "Update Runbooks",
    )
  })

  it("doesn't say to update when a later version wouldn't meet the requirement either", () => {
    expect(versionRequirementError(runbook('runbooks: "< 0.28"'), "0.28.0")).toBe(
      "This runbook needs Runbooks < 0.28, and this is Runbooks 0.28.0.",
    )
    expect(versionRequirementError(runbook('runbooks: "~> 0.28"'), "1.0.0")).not.toContain("Update")
    expect(versionRequirementError(runbook('runbooks: "!= 0.28.0"'), "0.28.0")).not.toContain(
      "Update",
    )
  })

  it("reports a requirement it can't read", () => {
    expect(versionRequirementError(runbook("runbooks: 0.30"), "0.28.0")).toBe(
      'Quote the version of Runbooks in the front matter, as in runbooks: ">= 0.28". YAML reads an unquoted 0.30 as the number 0.3.',
    )
    expect(versionRequirementError(runbook("runbooks: [0.28]"), "0.28.0")).toBe(
      '`runbooks` in the front matter must be text, such as runbooks: ">= 0.28".',
    )
    expect(versionRequirementError(runbook('runbooks: "newest"'), "0.28.0")).toBe(
      '`runbooks` in the front matter isn\'t a version of Runbooks: "newest" isn\'t a version condition such as ">= 1.6" or "~> 1.6".',
    )
  })

  it("reports front matter that isn't valid YAML", () => {
    expect(versionRequirementError(runbook("title: [Deploy"), "0.28.0")).toStartWith(
      "The runbook's front matter isn't valid YAML: ",
    )
  })
})

describe("unknownBlocks", () => {
  it("is each block that isn't known, once, in order, leaving out HTML elements", () => {
    const known = new Set(["Command", "Admonition"])
    const names = ["Command", "Chapter", "div", "Tabs", "Chapter", "ui.Tabs", "Admonition", "svg"]
    expect(unknownBlocks(names, known)).toEqual(["Chapter", "Tabs", "ui.Tabs"])
  })
})

describe("unknownBlocksError", () => {
  it("names the blocks this version doesn't have, and how to use the runbook", () => {
    expect(unknownBlocksError(["Chapter"], "0.27.0")).toBe(
      "This runbook uses <Chapter>, a block that Runbooks 0.27.0 doesn't have. If a later version of Runbooks added it, update Runbooks to use this runbook. Otherwise, check its name.",
    )
    expect(unknownBlocksError(["Chapter", "Tabs", "Quiz"], "0.27.0")).toStartWith(
      "This runbook uses <Chapter>, <Tabs> and <Quiz>, blocks that Runbooks 0.27.0 doesn't have. If a later version of Runbooks added them,",
    )
  })
})
