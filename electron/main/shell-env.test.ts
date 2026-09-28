import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { isTerminalLaunch, parseEnvDump, populateShellEnv } from "./shell-env.ts"

const MARKER = "__RUNBOOKS_SHELL_ENV_MARKER__"

describe("isTerminalLaunch", () => {
  it("treats TERM alone as a terminal launch (GNOME Terminal, Konsole, xterm, ssh)", () => {
    expect(isTerminalLaunch({ TERM: "xterm-256color" })).toBe(true)
  })

  it("still honors TERM_PROGRAM, which the e2e suite sets to skip the capture", () => {
    expect(isTerminalLaunch({ TERM_PROGRAM: "runbooks-e2e" })).toBe(true)
  })

  it("still honors ITERM_SESSION_ID", () => {
    expect(isTerminalLaunch({ ITERM_SESSION_ID: "w0t0p0:1234" })).toBe(true)
  })

  it("treats a launchd / desktop-entry env as a GUI launch", () => {
    expect(isTerminalLaunch({ PATH: "/usr/bin:/bin", HOME: "/Users/me", SHELL: "/bin/zsh" })).toBe(false)
  })

  it("treats TERM=linux as a GUI launch from a desktop session started on a TTY", () => {
    expect(isTerminalLaunch({ TERM: "linux", SHELL: "/bin/zsh" })).toBe(false)
    expect(isTerminalLaunch({ TERM: "linux", TERM_PROGRAM: "runbooks-e2e" })).toBe(true)
  })
})

describe("parseEnvDump", () => {
  it("skips rc-file noise printed before the marker", () => {
    const stdout = `Last login: Mon\n\u001b[1mwelcome\u001b[0m\n${MARKER}\0A=1\0B=two\0`
    expect(parseEnvDump(stdout)).toEqual([
      ["A", "1"],
      ["B", "two"],
    ])
  })

  it("keeps '=' and newlines inside values, and empty values", () => {
    const pem = "-----BEGIN KEY-----\nabc=\n-----END KEY-----"
    const stdout = `${MARKER}\0OPTS=--flag=value\0KEY=${pem}\0EMPTY=\0`
    expect(parseEnvDump(stdout)).toEqual([
      ["OPTS", "--flag=value"],
      ["KEY", pem],
      ["EMPTY", ""],
    ])
  })

  it("skips entries without '='", () => {
    expect(parseEnvDump(`${MARKER}\0garbage\0A=1\0`)).toEqual([["A", "1"]])
  })

  it("returns [] when the marker is missing", () => {
    expect(parseEnvDump("A=1\0B=2\0")).toEqual([])
  })
})

describe.skipIf(process.platform === "win32")("populateShellEnv", () => {
  let tmpDir = ""
  let savedEnv: NodeJS.ProcessEnv = {}

  beforeEach(() => {
    savedEnv = { ...process.env }
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-shell-env-"))
    // Stand-in for the user's $SHELL: prints rc-file noise and exports what
    // an rc file would, then runs the capture script ("$2", after -ilc).
    const fakeShell = nodePath.join(tmpDir, "fake-shell")
    fs.writeFileSync(
      fakeShell,
      [
        "#!/bin/sh",
        "echo 'rc-file noise'",
        "export GITLAB_HOST=gitlab.from-rc",
        "export SHLVL=99",
        'exec /bin/sh -c "$2"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    process.env.SHELL = fakeShell
    process.env.SHLVL = "7"
    delete process.env.TERM
    delete process.env.TERM_PROGRAM
    delete process.env.ITERM_SESSION_ID
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("keeps the env inherited from a terminal that sets only TERM", () => {
    process.env.TERM = "xterm-256color"
    process.env.GITLAB_HOST = "gitlab.corp"

    populateShellEnv()

    expect(process.env.GITLAB_HOST).toBe("gitlab.corp")
  })

  it("on a GUI launch, lets login-shell values win except for protected keys", () => {
    process.env.GITLAB_HOST = "gitlab.session"

    populateShellEnv()

    expect(process.env.GITLAB_HOST).toBe("gitlab.from-rc")
    expect(process.env.SHLVL).toBe("7")
  })
})
