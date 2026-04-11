import { describe, it, expect } from "bun:test"
import { isRemoteURL } from "./remote.ts"

describe("isRemoteURL", () => {
  it("detects HTTPS GitHub URLs", () => {
    expect(isRemoteURL("https://github.com/owner/repo/tree/main/path")).toBe(true)
  })

  it("detects HTTPS GitLab URLs", () => {
    expect(isRemoteURL("https://gitlab.com/owner/repo/-/tree/main/path")).toBe(true)
  })

  it("detects HTTP URLs", () => {
    expect(isRemoteURL("http://github.com/owner/repo")).toBe(true)
  })

  it("detects git:: prefix URLs", () => {
    expect(isRemoteURL("git::https://github.com/owner/repo.git//path?ref=v1.0")).toBe(true)
  })

  it("detects GitHub shorthand", () => {
    expect(isRemoteURL("github.com/owner/repo//path")).toBe(true)
  })

  it("detects GitLab shorthand", () => {
    expect(isRemoteURL("gitlab.com/owner/repo//path")).toBe(true)
  })

  it("rejects local paths", () => {
    expect(isRemoteURL("./path/to/runbook.mdx")).toBe(false)
    expect(isRemoteURL("/absolute/path/to/runbook.mdx")).toBe(false)
    expect(isRemoteURL("relative/path")).toBe(false)
  })

  it("rejects bare filenames", () => {
    expect(isRemoteURL("runbook.mdx")).toBe(false)
  })

  it("handles whitespace", () => {
    expect(isRemoteURL("  https://github.com/owner/repo  ")).toBe(true)
  })
})
