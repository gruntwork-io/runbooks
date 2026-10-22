import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import {
  isTerminalLaunch,
  parseEnvDump,
  populateShellEnv,
  readLoginShellPath,
} from "./shell-env.ts"

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
    expect(isTerminalLaunch({ PATH: "/usr/bin:/bin", HOME: "/Users/me", SHELL: "/bin/zsh" })).toBe(
      false,
    )
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

describe.skipIf(process.platform === "win32")("readLoginShellPath", () => {
  let tmpDir = ""
  let savedEnv: NodeJS.ProcessEnv = {}

  /** Make $SHELL a script that runs `rcLines`, as an rc file would, then the capture script. */
  function fakeShell(rcLines: string[]): string {
    const shell = nodePath.join(tmpDir, "fake-shell")
    fs.writeFileSync(shell, ["#!/bin/sh", ...rcLines, 'exec /bin/sh -c "$2"', ""].join("\n"), {
      mode: 0o755,
    })
    process.env.SHELL = shell
    return shell
  }

  beforeEach(() => {
    savedEnv = { ...process.env }
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-shell-path-"))
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reads the PATH the login shell's rc files set, even on a terminal launch", async () => {
    const shell = fakeShell(["echo 'rc-file noise'", 'export PATH="/from/rc:$PATH"'])
    process.env.TERM = "xterm-256color"

    const { shell: used, path } = await readLoginShellPath()

    expect(used).toBe(shell)
    expect(path.split(":")[0]).toBe("/from/rc")
  })

  it("leaves process.env alone", async () => {
    fakeShell(['export PATH="/from/rc:$PATH"', "export GITLAB_HOST=gitlab.from-rc"])
    const before = { ...process.env }

    await readLoginShellPath()

    expect(process.env).toEqual(before)
  })

  it("returns soon after the shell exits, though a background job holds its stdout open", async () => {
    fakeShell(["(sleep 5) &", 'export PATH="/from/rc:$PATH"'])
    const start = Date.now()

    const { path } = await readLoginShellPath()

    expect(path.startsWith("/from/rc:")).toBe(true)
    expect(Date.now() - start).toBeLessThan(4000)
  })

  it("rejects, saying why, when SHELL isn't set or the shell prints no env", async () => {
    delete process.env.SHELL
    await expect(readLoginShellPath()).rejects.toThrow(
      "SHELL isn't set, so there's no login shell to read PATH from.",
    )

    process.env.SHELL = nodePath.join(tmpDir, "no-such-shell")
    await expect(readLoginShellPath()).rejects.toThrow(/^Couldn't run .*no-such-shell/)

    const shell = nodePath.join(tmpDir, "quiet-shell")
    fs.writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.env.SHELL = shell
    await expect(readLoginShellPath()).rejects.toThrow(`${shell} printed no PATH.`)
  })
})
