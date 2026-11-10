import { describe, expect, it } from "bun:test"
import { ancestorsOf, hasRootHcl, placeUnit, repoFolder } from "./unit.ts"

describe("repoFolder", () => {
  it("normalizes a folder inside the repository", () => {
    expect(repoFolder(" google-groups//eng@example.com/ ")).toBe("google-groups/eng@example.com")
    expect(repoFolder("./a\\b")).toBe("a/b")
  })

  it("refuses a folder outside it", () => {
    expect(() => repoFolder("/etc")).toThrow("isn't a folder inside")
    expect(() => repoFolder("")).toThrow("isn't a folder inside")
    expect(() => repoFolder("a/../../b")).toThrow("leaves the repository")
  })
})

describe("ancestorsOf", () => {
  it("lists the folders above, from the root", () => {
    expect(ancestorsOf("a/b/c")).toEqual(["", "a", "a/b"])
  })
})

describe("placeUnit", () => {
  const rendered = [{ path: "terragrunt.hcl", content: "new" }]

  it("adds a unit the repository doesn't have, beside the files it may include", () => {
    const files = placeUnit(
      "prod/groups/eng",
      rendered,
      new Map([
        ["root.hcl", "root"],
        ["prod/account.hcl", "account"],
        ["prod/README.md", "not configuration"],
        ["staging/account.hcl", "another branch of the tree"],
        ["prod/groups/eng/terraform.tfstate", "not rendered"],
      ]),
    )
    expect(files).toEqual([
      { path: "prod/account.hcl", content: "account", status: "context" },
      { path: "prod/groups/eng/terragrunt.hcl", content: "new", status: "added" },
      { path: "root.hcl", content: "root", status: "context" },
    ])
    expect(hasRootHcl(files)).toBe(true)
  })

  it("marks a file it changes with what the repository holds now", () => {
    const files = placeUnit("eng", rendered, new Map([["eng/terragrunt.hcl", "old"]]))
    expect(files).toEqual([
      { path: "eng/terragrunt.hcl", content: "new", status: "modified", before: "old" },
    ])
    expect(hasRootHcl(files)).toBe(false)
  })

  it("marks a file that already matches as unchanged, whatever its line endings", () => {
    expect(placeUnit("eng", rendered, new Map([["eng/terragrunt.hcl", "new\r\n"]]))).toEqual([
      { path: "eng/terragrunt.hcl", content: "new", status: "unchanged" },
    ])
  })
})
