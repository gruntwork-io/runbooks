import { describe, it, expect } from "vitest"
import { parseCliArgs } from "./cli.ts"

describe("parseCliArgs", () => {
  it("parses a local runbook path", () => {
    const config = parseCliArgs(["electron", "./path/to/runbook.mdx"])
    expect(config.runbookPath).toContain("runbook.mdx")
    expect(config.remoteUrl).toBeNull()
  })

  it("parses a GitHub URL as remoteUrl", () => {
    const url = "https://github.com/owner/repo/tree/main/path/to/runbook"
    const config = parseCliArgs(["electron", url])
    expect(config.remoteUrl).toBe(url)
    expect(config.runbookPath).toBeNull()
  })

  it("parses a GitLab URL as remoteUrl", () => {
    const url = "https://gitlab.com/owner/repo/-/tree/main/path"
    const config = parseCliArgs(["electron", url])
    expect(config.remoteUrl).toBe(url)
    expect(config.runbookPath).toBeNull()
  })

  it("parses --runbook flag with a URL", () => {
    const url = "https://github.com/owner/repo/tree/main/path"
    const config = parseCliArgs(["electron", "--runbook", url])
    expect(config.remoteUrl).toBe(url)
    expect(config.runbookPath).toBeNull()
  })

  it("parses --runbook flag with a local path", () => {
    const config = parseCliArgs(["electron", "--runbook", "./local/runbook.mdx"])
    expect(config.runbookPath).toContain("runbook.mdx")
    expect(config.remoteUrl).toBeNull()
  })

  it("parses git:: prefix URL as remoteUrl", () => {
    const url = "git::https://github.com/owner/repo.git//path?ref=v1.0"
    const config = parseCliArgs(["electron", url])
    expect(config.remoteUrl).toBe(url)
    expect(config.runbookPath).toBeNull()
  })

  it("parses GitHub shorthand as remoteUrl", () => {
    const url = "github.com/owner/repo//path?ref=main"
    const config = parseCliArgs(["electron", url])
    expect(config.remoteUrl).toBe(url)
    expect(config.runbookPath).toBeNull()
  })

  it("parses --watch flag", () => {
    const config = parseCliArgs(["electron", "--watch"])
    expect(config.watch).toBe(true)
  })

  it("returns defaults when no args", () => {
    const config = parseCliArgs(["electron"])
    expect(config.runbookPath).toBeNull()
    expect(config.remoteUrl).toBeNull()
    expect(config.watch).toBe(false)
  })
})
