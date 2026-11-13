import { describe, it, expect } from "vitest"
import { matchesSelectedPath, startsSelected, suggestCommitMessage } from "../selection"
import type { WorkspaceFileChange } from "@/contexts/WorkspaceGitDataContext.types"

describe("matchesSelectedPath", () => {
  it.each([
    ["live/acme/terragrunt.hcl", "live/acme/terragrunt.hcl", true],
    ["live/acme", "live/acme/terragrunt.hcl", true],
    ["live/acme/", "live/acme/terragrunt.hcl", true],
    ["./live/acme", "live/acme/terragrunt.hcl", true],
    ["live/acm", "live/acme/terragrunt.hcl", false],
    ["live/*/terragrunt.hcl", "live/acme/terragrunt.hcl", true],
    ["live/*/terragrunt.hcl", "live/a/b/terragrunt.hcl", false],
    ["live/**/terragrunt.hcl", "live/a/b/terragrunt.hcl", true],
    ["live/**/terragrunt.hcl", "live/terragrunt.hcl", true],
    ["**/*.hcl", "live/a/unit.hcl", true],
    ["*.hcl", "live/a/unit.hcl", false],
    ["live/**", "live/a/unit.hcl", true],
    ["docs/a.b", "docs/aXb", false],
    ["", "anything", false],
  ])("%s matches %s: %s", (pattern, path, expected) => {
    expect(matchesSelectedPath(pattern, path)).toBe(expected)
  })
})

describe("startsSelected", () => {
  it("chooses every file without selectedPaths", () => {
    expect(startsSelected(undefined, "any/file")).toBe(true)
  })

  it("chooses only the files the patterns match", () => {
    expect(startsSelected(["live/acme"], "live/acme/unit.hcl")).toBe(true)
    expect(startsSelected(["live/acme"], "live/other/unit.hcl")).toBe(false)
    expect(startsSelected([], "live/acme/unit.hcl")).toBe(false)
  })
})

const change = (path: string, changeType: WorkspaceFileChange["changeType"]) =>
  ({ path, changeType, additions: 0, deletions: 0, language: "" }) satisfies WorkspaceFileChange

describe("suggestCommitMessage", () => {
  it("names one file by its change", () => {
    expect(suggestCommitMessage([change("live/acme/unit.hcl", "added")])).toBe(
      "Add live/acme/unit.hcl",
    )
    expect(suggestCommitMessage([change("README.md", "deleted")])).toBe("Delete README.md")
  })

  it("counts several files and names the folder they share", () => {
    expect(
      suggestCommitMessage([
        change("live/acme/a/terragrunt.hcl", "added"),
        change("live/acme/b/terragrunt.hcl", "added"),
      ]),
    ).toBe("Add 2 files in live/acme")
    expect(
      suggestCommitMessage([change("live/a.hcl", "added"), change("docs/b.md", "modified")]),
    ).toBe("Update 2 files")
  })

  it("is empty with nothing chosen", () => {
    expect(suggestCommitMessage([])).toBe("")
  })
})
