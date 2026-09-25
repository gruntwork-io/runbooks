import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { spawnSync } from "node:child_process"

// cli-install.ts reads electron's `app.isPackaged` only inside the exported
// entry points, which these tests do not call. Stub the module so the import
// graph resolves without an Electron runtime.
mock.module("electron", () => ({
  app: { isPackaged: false },
}))

const {
  LAUNCHER_MARKER,
  resolveLaunchTarget,
  shellSingleQuote,
  renderUnixLauncher,
  renderWindowsLauncher,
  probeLauncher,
  classifyLauncher,
  appleScriptQuote,
  installCommand,
  removeCommand,
  shellInvocation,
  installUnixLauncher,
  uninstallUnixLauncher,
} = await import("./cli-install.ts")

const isWindows = process.platform === "win32"

/** Runs a command the way the unprivileged install path does. */
function runWithSh(command: string): Promise<void> {
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" })
  if (result.status !== 0) {
    return Promise.reject(new Error(`sh exited ${result.status}: ${result.stderr}`))
  }
  return Promise.resolve()
}

/** Records every command, then runs it. */
function recordingRunner() {
  const commands: string[] = []
  const run = (command: string) => {
    commands.push(command)
    return runWithSh(command)
  }
  return { commands, run }
}

let tmp = ""

beforeEach(() => {
  // realpath: os.tmpdir() is behind a /var -> /private/var symlink on macOS.
  tmp = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-cli-install-")))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// What the launcher runs
// ---------------------------------------------------------------------------

describe("resolveLaunchTarget", () => {
  const macExec = "/Applications/Runbooks.app/Contents/MacOS/Runbooks"

  it("runs the packaged app's own executable", () => {
    expect(
      resolveLaunchTarget({ platform: "darwin", execPath: macExec, isPackaged: true, env: {} }),
    ).toBe(macExec)
    expect(
      resolveLaunchTarget({
        platform: "win32",
        execPath: "C:\\Program Files\\Runbooks\\Runbooks.exe",
        isPackaged: true,
        env: {},
      }),
    ).toBe("C:\\Program Files\\Runbooks\\Runbooks.exe")
  })

  it("refuses a development build, whose execPath is bare Electron", () => {
    expect(() =>
      resolveLaunchTarget({
        platform: "darwin",
        execPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        isPackaged: false,
        env: {},
      }),
    ).toThrow(/development build/)
  })

  it("runs the .AppImage file, not the temporary mount it was extracted to", () => {
    // execPath lives in /tmp/.mount_*, which disappears when the app exits.
    expect(
      resolveLaunchTarget({
        platform: "linux",
        execPath: "/tmp/.mount_RunbkX1/runbooks",
        isPackaged: true,
        env: { APPIMAGE: "/home/dev/Apps/Runbooks.AppImage", APPDIR: "/tmp/.mount_RunbkX1" },
      }),
    ).toBe("/home/dev/Apps/Runbooks.AppImage")
    expect(
      resolveLaunchTarget({
        platform: "linux",
        execPath: "/tmp/.mount_RunbkX1/runbooks",
        isPackaged: true,
        env: { APPIMAGE: "/home/dev/Apps/Runbooks.AppImage" },
      }),
    ).toBe("/home/dev/Apps/Runbooks.AppImage")
  })

  it("ignores an APPIMAGE inherited from another AppImage", () => {
    // A .deb install started from an AppImage'd terminal inherits the
    // terminal's APPIMAGE/APPDIR; the launcher must still run Runbooks.
    const env = { APPIMAGE: "/home/dev/Apps/Terminal.AppImage", APPDIR: "/tmp/.mount_Term" }
    expect(
      resolveLaunchTarget({ platform: "linux", execPath: "/opt/Runbooks/runbooks", isPackaged: true, env }),
    ).toBe("/opt/Runbooks/runbooks")
    // A sibling mount that merely shares a prefix is not "inside" APPDIR.
    expect(
      resolveLaunchTarget({
        platform: "linux",
        execPath: "/tmp/.mount_Terminal/runbooks",
        isPackaged: true,
        env,
      }),
    ).toBe("/tmp/.mount_Terminal/runbooks")
  })

  it("refuses a translocated macOS app, whose path vanishes on quit", () => {
    expect(() =>
      resolveLaunchTarget({
        platform: "darwin",
        execPath:
          "/private/var/folders/x1/abc/T/AppTranslocation/0F1E2D3C/d/Runbooks.app/Contents/MacOS/Runbooks",
        isPackaged: true,
        env: {},
      }),
    ).toThrow(/Applications folder/)
  })
})

// ---------------------------------------------------------------------------
// Launcher contents
// ---------------------------------------------------------------------------

describe("renderUnixLauncher", () => {
  it("execs the target by absolute path and carries the marker", () => {
    expect(renderUnixLauncher("/Applications/Runbooks.app/Contents/MacOS/Runbooks")).toBe(
      [
        "#!/bin/sh",
        `# ${LAUNCHER_MARKER}`,
        `exec '/Applications/Runbooks.app/Contents/MacOS/Runbooks' "$@"`,
        "",
      ].join("\n"),
    )
  })

  it("quotes a path with a single quote in it", () => {
    expect(shellSingleQuote("/Users/o'brien/Runbooks")).toBe("'/Users/o'\\''brien/Runbooks'")
    expect(renderUnixLauncher("/Users/o'brien/Runbooks")).toContain(
      `exec '/Users/o'\\''brien/Runbooks' "$@"`,
    )
  })

  it.skipIf(isWindows)("runs a hostile target path and passes arguments and exit code through", () => {
    const appDir = nodePath.join(tmp, `My "Apps" it's $HOME \\ dir`)
    fs.mkdirSync(appDir)
    const target = nodePath.join(appDir, "Runbooks")
    // Stand-in for the app: prints each argument on its own line.
    fs.writeFileSync(target, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\nexit 7\n', {
      mode: 0o755,
    })
    const launcher = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(launcher, renderUnixLauncher(target), { mode: 0o755 })

    const args = ["./my runbook.mdx", "*", "$HOME", "it's"]
    const result = spawnSync(launcher, args, { encoding: "utf8" })
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe(args.map((a) => `${a}\n`).join(""))
    expect(result.status).toBe(7)
  })
})

describe("renderWindowsLauncher", () => {
  it("runs the executable by absolute path with CRLF line endings", () => {
    const text = renderWindowsLauncher("C:\\Program Files\\Runbooks\\Runbooks.exe", "C:\\Users\\dev\\AppData\\Local")
    expect(text).toBe(
      ["@echo off", `rem ${LAUNCHER_MARKER}`, '"C:\\Program Files\\Runbooks\\Runbooks.exe" %*', ""].join("\r\n"),
    )
  })

  it("doubles a literal percent sign so cmd.exe does not expand it", () => {
    expect(renderWindowsLauncher("C:\\100%done\\Runbooks.exe")).toContain('"C:\\100%%done\\Runbooks.exe" %*')
  })

  it("writes a per-user install path through %LOCALAPPDATA%", () => {
    // cmd.exe would read the UTF-8 bytes of "José" in the OEM code page.
    const localAppData = "C:\\Users\\José\\AppData\\Local"
    expect(
      renderWindowsLauncher("C:\\Users\\José\\AppData\\Local\\Programs\\Runbooks\\Runbooks.exe", localAppData),
    ).toContain('"%LOCALAPPDATA%\\Programs\\Runbooks\\Runbooks.exe" %*')
    // Case-insensitive, tolerant of a trailing separator, and still escaping
    // the rest of the path.
    expect(
      renderWindowsLauncher("c:\\users\\josé\\appdata\\local\\Programs\\100%\\Runbooks.exe", `${localAppData}\\`),
    ).toContain('"%LOCALAPPDATA%\\Programs\\100%%\\Runbooks.exe" %*')
    // A sibling directory that merely shares the prefix is left alone.
    expect(
      renderWindowsLauncher("C:\\Users\\José\\AppData\\LocalLow\\Runbooks.exe", localAppData),
    ).toContain('"C:\\Users\\José\\AppData\\LocalLow\\Runbooks.exe" %*')
  })
})

// ---------------------------------------------------------------------------
// What is already at the launcher path
// ---------------------------------------------------------------------------

describe("classifyLauncher", () => {
  const expected = renderUnixLauncher("/Applications/Runbooks.app/Contents/MacOS/Runbooks")

  it("reports absent, installed, stale and occupied", () => {
    expect(classifyLauncher({ present: false }, expected)).toBe("absent")
    expect(classifyLauncher({ present: true, content: expected }, expected)).toBe("installed")
    // Written by a copy of the app that has since moved.
    expect(
      classifyLauncher({ present: true, content: renderUnixLauncher("/Users/dev/Desktop/Runbooks") }, expected),
    ).toBe("stale")
    // A symlink, directory or binary: no content to inspect.
    expect(classifyLauncher({ present: true }, expected)).toBe("occupied")
    // Someone else's script.
    expect(classifyLauncher({ present: true, content: "#!/bin/sh\necho hi\n" }, expected)).toBe("occupied")
  })
})

describe.skipIf(isWindows)("probeLauncher + classifyLauncher on a real directory", () => {
  const target = "/Applications/Runbooks.app/Contents/MacOS/Runbooks"
  const expected = renderUnixLauncher(target)
  const state = (p: string) => classifyLauncher(probeLauncher(p), expected)

  it("reports absent when nothing is there", () => {
    expect(state(nodePath.join(tmp, "runbooks"))).toBe("absent")
  })

  it("recognises our launcher, current or stale", () => {
    const p = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(p, expected)
    expect(state(p)).toBe("installed")
    fs.writeFileSync(p, renderUnixLauncher("/Volumes/Old/Runbooks.app/Contents/MacOS/Runbooks"))
    expect(state(p)).toBe("stale")
  })

  it("reports a regular file it did not write, such as the legacy CLI, as occupied", () => {
    const p = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(p, "#!/bin/sh\necho legacy runbooks\n", { mode: 0o755 })
    expect(state(p)).toBe("occupied")
    // A large binary is never read, even if the marker happens to be in it.
    fs.writeFileSync(p, Buffer.concat([Buffer.alloc(128 * 1024), Buffer.from(LAUNCHER_MARKER)]))
    expect(state(p)).toBe("occupied")
  })

  it("never follows a symlink, even one pointing at our own launcher", () => {
    const ours = nodePath.join(tmp, "ours")
    fs.writeFileSync(ours, expected)
    const absolute = nodePath.join(tmp, "absolute")
    fs.symlinkSync(ours, absolute)
    expect(state(absolute)).toBe("occupied")

    const relative = nodePath.join(tmp, "relative")
    fs.symlinkSync("ours", relative)
    expect(state(relative)).toBe("occupied")

    const dangling = nodePath.join(tmp, "dangling")
    fs.symlinkSync(nodePath.join(tmp, "gone"), dangling)
    expect(state(dangling)).toBe("occupied")
  })

  it("reports a directory as occupied", () => {
    const p = nodePath.join(tmp, "runbooks")
    fs.mkdirSync(p)
    expect(state(p)).toBe("occupied")
  })
})

// ---------------------------------------------------------------------------
// Install and uninstall guards
// ---------------------------------------------------------------------------

describe.skipIf(isWindows)("installUnixLauncher", () => {
  const content = renderUnixLauncher("/Applications/Runbooks.app/Contents/MacOS/Runbooks")

  it("writes an executable launcher, creating the directory", async () => {
    const launcher = nodePath.join(tmp, "usr", "local", "bin", "runbooks")
    const runner = recordingRunner()
    await installUnixLauncher(launcher, content, runner.run)
    expect(fs.readFileSync(launcher, "utf8")).toBe(content)
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o755)
    expect(runner.commands).toHaveLength(1)
  })

  it("removes the staged copy after installing", async () => {
    const launcher = nodePath.join(tmp, "runbooks")
    let staged = ""
    await installUnixLauncher(launcher, content, (command) => {
      staged = command.match(/install -m 0755 '([^']+)'/)?.[1] ?? ""
      return runWithSh(command)
    })
    expect(staged).not.toBe("")
    expect(fs.existsSync(staged)).toBe(false)
  })

  it("replaces a stale launcher left by a moved app", async () => {
    const launcher = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(launcher, renderUnixLauncher("/Users/dev/Desktop/Runbooks.app/Contents/MacOS/Runbooks"))
    await installUnixLauncher(launcher, content, runWithSh)
    expect(fs.readFileSync(launcher, "utf8")).toBe(content)
  })

  it("does nothing when already installed", async () => {
    const launcher = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(launcher, content, { mode: 0o755 })
    const runner = recordingRunner()
    await installUnixLauncher(launcher, content, runner.run)
    expect(runner.commands).toEqual([])
  })

  it("refuses to overwrite a regular file it did not write", async () => {
    // /usr/local/bin/runbooks is often the older Go CLI.
    const launcher = nodePath.join(tmp, "runbooks")
    const legacy = "#!/bin/sh\necho legacy runbooks\n"
    fs.writeFileSync(launcher, legacy, { mode: 0o755 })
    const runner = recordingRunner()
    await expect(installUnixLauncher(launcher, content, runner.run)).rejects.toThrow(
      /will not overwrite it/,
    )
    expect(runner.commands).toEqual([])
    expect(fs.readFileSync(launcher, "utf8")).toBe(legacy)
  })

  it("refuses to replace another tool's symlink, dangling or not", async () => {
    const other = nodePath.join(tmp, "Cellar", "runbooks")
    fs.mkdirSync(nodePath.dirname(other))
    fs.writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 })
    const link = nodePath.join(tmp, "runbooks")
    fs.symlinkSync("Cellar/runbooks", link)
    const runner = recordingRunner()
    await expect(installUnixLauncher(link, content, runner.run)).rejects.toThrow(/will not overwrite it/)
    expect(fs.readlinkSync(link)).toBe("Cellar/runbooks")

    fs.rmSync(other)
    await expect(installUnixLauncher(link, content, runner.run)).rejects.toThrow(/will not overwrite it/)
    expect(fs.readlinkSync(link)).toBe("Cellar/runbooks")
    expect(runner.commands).toEqual([])
  })

  it("fails when the privileged helper reports success but wrote nothing", async () => {
    const launcher = nodePath.join(tmp, "runbooks")
    await expect(installUnixLauncher(launcher, content, async () => {})).rejects.toThrow(
      /does not contain the Runbooks launcher/,
    )
  })
})

describe.skipIf(isWindows)("uninstallUnixLauncher", () => {
  const content = renderUnixLauncher("/Applications/Runbooks.app/Contents/MacOS/Runbooks")

  it("does nothing when nothing is installed", async () => {
    const runner = recordingRunner()
    expect(await uninstallUnixLauncher(nodePath.join(tmp, "runbooks"), runner.run)).toBe(false)
    expect(runner.commands).toEqual([])
  })

  it("removes our launcher, current or stale", async () => {
    const launcher = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(launcher, content)
    expect(await uninstallUnixLauncher(launcher, runWithSh)).toBe(true)
    expect(fs.existsSync(launcher)).toBe(false)

    fs.writeFileSync(launcher, renderUnixLauncher("/Users/dev/Desktop/Runbooks.app/Contents/MacOS/Runbooks"))
    expect(await uninstallUnixLauncher(launcher, runWithSh)).toBe(true)
    expect(fs.existsSync(launcher)).toBe(false)
  })

  it("refuses to remove a file or symlink it did not write", async () => {
    const runner = recordingRunner()
    const launcher = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(launcher, "#!/bin/sh\necho legacy runbooks\n")
    await expect(uninstallUnixLauncher(launcher, runner.run)).rejects.toThrow(/not installed by Runbooks/)
    expect(fs.existsSync(launcher)).toBe(true)

    const link = nodePath.join(tmp, "linked")
    fs.symlinkSync(launcher, link)
    await expect(uninstallUnixLauncher(link, runner.run)).rejects.toThrow(/not installed by Runbooks/)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(runner.commands).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Commands and escalation. These run with administrator privileges, so a
// hostile path must not be able to compose them.
// ---------------------------------------------------------------------------

describe("install and remove commands", () => {
  it("quotes every path", () => {
    expect(installCommand("/tmp/a b/runbooks", "/usr/local/bin/runbooks")).toBe(
      "mkdir -p '/usr/local/bin' && install -m 0755 '/tmp/a b/runbooks' '/usr/local/bin/runbooks'",
    )
    expect(removeCommand("/usr/local/bin/runbooks")).toBe("rm -f '/usr/local/bin/runbooks'")
  })

  it("escapes quotes and backslashes for an AppleScript literal", () => {
    expect(appleScriptQuote('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"')
  })

  it("runs directly when the directory is writable and escalates otherwise", () => {
    const command = "rm -f '/usr/local/bin/runbooks'"
    expect(shellInvocation("darwin", command, true)).toEqual({ file: "/bin/sh", args: ["-c", command] })
    expect(shellInvocation("darwin", command, false)).toEqual({
      file: "osascript",
      args: ["-e", `do shell script ${appleScriptQuote(command)} with administrator privileges`],
    })
    expect(shellInvocation("linux", command, false)).toEqual({
      file: "pkexec",
      args: ["/bin/sh", "-c", command],
    })
  })

  it.skipIf(process.platform !== "darwin")(
    "survives osascript's do shell script with a hostile staging path",
    () => {
      // Same parser as the privileged path, minus "with administrator
      // privileges", so no password prompt.
      const stagingDir = nodePath.join(tmp, `Weird "dir" it's \\ here`)
      fs.mkdirSync(stagingDir)
      const staged = nodePath.join(stagingDir, "runbooks")
      fs.writeFileSync(staged, "#!/bin/sh\n")
      const launcher = nodePath.join(tmp, "bin", "runbooks")

      const script = `do shell script ${appleScriptQuote(installCommand(staged, launcher))}`
      const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" })
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      expect(fs.statSync(launcher).mode & 0o777).toBe(0o755)
    },
  )
})
