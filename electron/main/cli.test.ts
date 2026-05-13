import { describe, it, expect } from "bun:test"
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
    expect(config.disableLiveFileReload).toBe(false)
  })

  it("parses --disable-live-file-reload flag", () => {
    const config = parseCliArgs(["electron", "--disable-live-file-reload"])
    expect(config.disableLiveFileReload).toBe(true)
  })

  it("parses --disable-live-file-reload with --watch", () => {
    const config = parseCliArgs(["electron", "--watch", "--disable-live-file-reload", "./path/to/runbook.mdx"])
    expect(config.watch).toBe(true)
    expect(config.disableLiveFileReload).toBe(true)
    expect(config.runbookPath).toContain("runbook.mdx")
  })

  it("resolves a bare positional runbook path to an absolute path", () => {
    const config = parseCliArgs(["runbooks", "./relative/runbook.mdx"])
    expect(config.runbookPath?.startsWith("/")).toBe(true)
    expect(config.runbookPath?.endsWith("/relative/runbook.mdx")).toBe(true)
  })

  it("parses --watch and --output-path together with a positional", () => {
    const config = parseCliArgs([
      "runbooks",
      "--watch",
      "--output-path",
      "out-dir",
      "./local/runbook.mdx",
    ])
    expect(config.watch).toBe(true)
    expect(config.outputPath?.endsWith("/out-dir")).toBe(true)
    expect(config.runbookPath?.endsWith("/local/runbook.mdx")).toBe(true)
  })

  it("parses --no-telemetry", () => {
    const config = parseCliArgs(["runbooks", "--no-telemetry"])
    expect(config.noTelemetry).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Electron-internal-flag regression suite.
  //
  // Electron may pass flags like `--remote-debugging-port=9229`,
  // `--no-sandbox`, or `--enable-logging` in argv. None of these should
  // be treated as a runbook path. The current filter only drops `--inspect*`
  // by name — we rely on the `!arg.startsWith("-")` check in the positional
  // branch to absorb the rest. These tests pin that behavior down so a
  // future refactor cannot silently regress it.
  // -----------------------------------------------------------------------

  it.each([
    ["--remote-debugging-port=9229"],
    ["--no-sandbox"],
    ["--enable-logging"],
    ["--inspect"],
    ["--inspect-brk=9229"],
    ["--disable-gpu"],
    ["--enable-logging=stderr"],
  ])("does not treat Electron-internal flag %s as a runbook path", (flag) => {
    const config = parseCliArgs(["runbooks", flag])
    expect(config.runbookPath).toBeNull()
    expect(config.remoteUrl).toBeNull()
  })

  it("still finds the positional runbook path when Electron-internal flags are present", () => {
    const config = parseCliArgs([
      "runbooks",
      "--no-sandbox",
      "--remote-debugging-port=9229",
      "./runbook.mdx",
    ])
    expect(config.runbookPath?.endsWith("/runbook.mdx")).toBe(true)
    expect(config.remoteUrl).toBeNull()
  })
})
