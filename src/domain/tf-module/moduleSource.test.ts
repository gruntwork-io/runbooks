import { describe, expect, it } from "bun:test"
import { moduleSourceInfo, unpinnedSourceWarning } from "./moduleSource.ts"

describe("moduleSourceInfo", () => {
  it("names a module in a GitHub repository, its ref, and its folder there", () => {
    expect(
      moduleSourceInfo(
        "git::https://github.com/fabricahq/infra-catalog.git//modules/google-group?ref=v0.14.0",
      ),
    ).toEqual({
      name: "google-group",
      ref: "v0.14.0",
      url: "https://github.com/fabricahq/infra-catalog/tree/v0.14.0/modules/google-group",
    })
  })

  it("reads scp-like and scheme-less GitHub addresses", () => {
    expect(moduleSourceInfo("git::git@github.com:acme/catalog.git//group?ref=v1").url).toBe(
      "https://github.com/acme/catalog/tree/v1/group",
    )
    expect(moduleSourceInfo("github.com/acme/catalog//group").url).toBe(
      "https://github.com/acme/catalog/tree/HEAD/group",
    )
  })

  it("names a module at a repository's root after the repository", () => {
    expect(moduleSourceInfo("git::https://github.com/acme/terraform-group.git?ref=v2")).toEqual({
      name: "terraform-group",
      ref: "v2",
      url: "https://github.com/acme/terraform-group/tree/v2",
    })
  })

  it("has no link for a module elsewhere", () => {
    expect(moduleSourceInfo("git::https://gitlab.com/acme/catalog.git//group?ref=v1")).toEqual({
      name: "group",
      ref: "v1",
    })
  })
})

describe("unpinnedSourceWarning", () => {
  it("warns about a remote source with no ref", () => {
    expect(
      unpinnedSourceWarning("git::https://github.com/acme/catalog.git//modules/group"),
    ).toContain("has no ?ref=")
  })

  it("accepts a pinned remote source and a local folder", () => {
    expect(
      unpinnedSourceWarning("git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0"),
    ).toBeUndefined()
    expect(unpinnedSourceWarning("modules/group")).toBeUndefined()
  })
})
