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

  it("parses --watch together with a positional", () => {
    const config = parseCliArgs(["runbooks", "--watch", "./local/runbook.mdx"])
    expect(config.watch).toBe(true)
    expect(config.runbookPath?.endsWith("/local/runbook.mdx")).toBe(true)
  })

  // -----------------------------------------------------------------------
  // Relative paths resolve against the caller's cwd. A second instance
  // forwards its argv to the first, whose own cwd may be "/" (Dock/launcher
  // start); Electron passes the second instance's cwd separately.
  // -----------------------------------------------------------------------

  it("resolves a positional path against the given cwd", () => {
    const config = parseCliArgs(["runbooks", "./rb"], "/home/me/proj")
    expect(config.runbookPath).toBe("/home/me/proj/rb")
  })

  it("resolves a --runbook path against the given cwd", () => {
    const config = parseCliArgs(["runbooks", "--runbook", "rb/runbook.mdx"], "/home/me/proj")
    expect(config.runbookPath).toBe("/home/me/proj/rb/runbook.mdx")
  })

  it("resolves a second-instance argv against the second instance's cwd", () => {
    // Shape Electron delivers to "second-instance": Chromium switches are
    // inserted before the entry script.
    const config = parseCliArgs(
      ["/Applications/Runbooks.app/Contents/MacOS/Runbooks", "--allow-file-access-from-files", "/repo/dist/main/index.js", "./rb"],
      "/p",
    )
    expect(config.runbookPath).toBe("/p/rb")
    expect(config.remoteUrl).toBeNull()
  })

  // -----------------------------------------------------------------------
  // Positional filters drop Electron's own arguments, not user input.
  // -----------------------------------------------------------------------

  it("keeps a positional path that contains 'electron'", () => {
    const config = parseCliArgs(["runbooks", "/home/me/electron-infra/runbooks/deploy"])
    expect(config.runbookPath).toBe("/home/me/electron-infra/runbooks/deploy")
  })

  it("keeps a positional URL that contains 'electron'", () => {
    const url = "https://github.com/electron/fiddle/tree/main/runbooks"
    const config = parseCliArgs(["runbooks", url])
    expect(config.remoteUrl).toBe(url)
    expect(config.runbookPath).toBeNull()
  })

  it("opens the current directory for a bare '.'", () => {
    const config = parseCliArgs(["runbooks", "."], "/home/me/proj")
    expect(config.runbookPath).toBe("/home/me/proj")
  })

  it("ignores the app's own path in an unpackaged run (electron .)", () => {
    const config = parseCliArgs(["electron", "."], "/repo", "/repo")
    expect(config.runbookPath).toBeNull()
  })

  it("still opens a runbook passed after the app path in an unpackaged run", () => {
    const config = parseCliArgs(["electron", ".", "./rb"], "/repo", "/repo")
    expect(config.runbookPath).toBe("/repo/rb")
  })

  it("finds no runbook in a Playwright launch argv", () => {
    const config = parseCliArgs(
      [
        "/x/Electron",
        "-r",
        "/x/node_modules/playwright-core/lib/server/electron/loader.js",
        "--inspect=0",
        "--remote-debugging-port=0",
        "/repo/dist/main/index.js",
      ],
      "/repo",
      "/repo/dist/main",
    )
    expect(config.runbookPath).toBeNull()
    expect(config.remoteUrl).toBeNull()
  })

  // -----------------------------------------------------------------------
  // --working-dir / --output-path (old Go CLI) are not supported. Their
  // values must be skipped so they can't be taken as the runbook path.
  // -----------------------------------------------------------------------

  it.each([
    [["open", "my-runbook", "--working-dir", "/path/to/project"]],
    [["open", "my-runbook", "--output-path", "./infrastructure"]],
    [["open", "--working-dir", "/path/to/project", "my-runbook"]],
    [["open", "my-runbook", "--working-dir=::tmp"]],
    [["open", "my-runbook", "--output-path=./infrastructure"]],
  ])("does not take the value of an unsupported flag as the runbook path: %p", (args) => {
    const config = parseCliArgs(["runbooks", ...args], "/home/me")
    expect(config.runbookPath).toBe("/home/me/my-runbook")
    expect(config.remoteUrl).toBeNull()
  })

  it("does not swallow the next flag after a value-less unsupported flag", () => {
    const config = parseCliArgs(["runbooks", "--output-path", "--watch", "./rb"], "/home/me")
    expect(config.watch).toBe(true)
    expect(config.runbookPath).toBe("/home/me/rb")
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
