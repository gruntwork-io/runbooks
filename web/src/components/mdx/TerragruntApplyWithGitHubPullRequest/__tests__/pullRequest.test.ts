import { describe, it, expect } from "vitest"
import type { TfModuleSpec } from "../../../../../../src/domain/tf-module/types"
import { draftBody, draftBranch, draftTitle } from "../pullRequest"

const spec = {
  title: "Create a Google Group",
  providers: [],
  outputs: [],
  warnings: [],
  variables: [
    { name: "id", label: "Group email", sensitive: false },
    { name: "owners", label: "Owners", sensitive: false },
    { name: "token", label: "Token", sensitive: true },
    { name: "description", label: "Description", sensitive: false },
  ],
} as unknown as TfModuleSpec

const values = { id: "team@example.com", owners: ["a@example.com", "b@example.com"], token: "s" }

describe("pull request drafts", () => {
  it("titles it from runbook_block.yml's template, or the block's title", () => {
    expect(draftTitle(spec, values)).toBe("Create a Google Group")
    expect(draftTitle({ ...spec, pullRequest: { title: "Add the {{ .id }} group" } }, values)).toBe(
      "Add the team@example.com group",
    )
  })

  it("describes it with the inputs that have a value, leaving out sensitive ones", () => {
    const body = draftBody(spec, values)
    expect(body).toContain("| Group email | `team@example.com` |")
    expect(body).toContain("| Owners | `a@example.com, b@example.com` |")
    expect(body).not.toContain("Token")
    expect(body).not.toContain("Description |")
  })

  it("opens the description with the module's summary, above the inputs", () => {
    const body = draftBody(
      { ...spec, pullRequest: { summary: "Creates the {{ .id }} Google group." } },
      values,
    )
    expect(body.split("\n").slice(0, 3)).toEqual([
      "Creates the team@example.com Google group.",
      "",
      "| Input | Value |",
    ])
    expect(body).toContain("| Group email | `team@example.com` |")
  })

  it("names the branch from the title", () => {
    expect(draftBranch("Add the team@example.com group")).toBe(
      "runbooks/add-the-team-example-com-group",
    )
    expect(draftBranch("!!!")).toBe("runbooks/change")
  })
})
