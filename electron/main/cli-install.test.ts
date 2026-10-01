import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { spawnSync } from "node:child_process"
import { mockElectron } from "./test-utils/mock-electron.ts"

// cli-install.ts reads electron's `app.isPackaged` only inside the exported
// entry points, which these tests do not call. Stub the module so the import
// graph resolves without an Electron runtime. Through mockElectron, like every
// electron mock: a bare mock.module declaring only `app` would fix the
// module's export names for the whole bun process, and later files that
// import `ipcMain` would fail to load.
mockElectron({ app: { isPackaged: false } })

const {
  LAUNCHER_MARKER,
  resolveLaunchTarget,
  shellSingleQuote,
  renderTemplate,
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
const { parseCliArgs } = await import("./cli.ts")

const isWindows = process.platform === "win32"

/** Runs a command the way the unprivileged install path does. */
function runWithSh(command: string): Promise<void> {
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: process.env })
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

describe("renderTemplate", () => {
  it("drops note lines, indented ones too, and writes the given line endings", () => {
    const template = "#!/bin/sh\n## a note\nif true; then\n  ## an indented note\n  echo {{word}}\nfi\n"
    expect(renderTemplate(template, "##", "\r\n", { word: "hi" })).toBe(
      "#!/bin/sh\r\nif true; then\r\n  echo hi\r\nfi\r\n",
    )
  })

  it("renders the same from a checkout that gave the template CRLF endings", () => {
    const lf = "@echo off\n:: a note\nrem {{marker}}\n"
    const crlf = lf.replace(/\n/g, "\r\n")
    const values = { marker: LAUNCHER_MARKER }
    expect(renderTemplate(crlf, "::", "\r\n", values)).toBe(renderTemplate(lf, "::", "\r\n", values))
    expect(renderTemplate(crlf, "::", "\n", values)).toBe(`@echo off\nrem ${LAUNCHER_MARKER}\n`)
  })

  it("inserts values verbatim, never as replacement patterns or further placeholders", () => {
    // String.replace would read $& and $' in a replacement string, and a
    // second pass would expand a {{name}} that came from a path. A newline in
    // a value is not a template line ending, so it is left as it is.
    const value = "/opt/{{other}}/$&/$'/$`/$1\nnext"
    expect(renderTemplate("a={{value}} b={{other}}\n", "##", "\r\n", { value, other: "x" })).toBe(
      `a=${value} b=x\r\n`,
    )
  })

  it("refuses a placeholder it has no value for", () => {
    expect(() => renderTemplate("{{app}} {{typo}}\n", "##", "\n", { app: "x" })).toThrow(/\{\{typo\}\}/)
    // Not even one that names an Object.prototype member.
    expect(() => renderTemplate("{{constructor}}\n", "##", "\n", {})).toThrow(/\{\{constructor\}\}/)
  })
})

describe("renderUnixLauncher", () => {
  it("starts the target in the background by absolute path and carries the marker", () => {
    expect(renderUnixLauncher("/Applications/Runbooks.app/Contents/MacOS/Runbooks")).toBe(
      [
        "#!/bin/sh",
        // Still line 2, as in every earlier release: it is how install and
        // uninstall recognise a launcher an older version wrote.
        `# ${LAUNCHER_MARKER}`,
        `app='/Applications/Runbooks.app/Contents/MacOS/Runbooks'`,
        `if [ ! -x "$app" ]; then`,
        `  printf "runbooks: Runbooks was not found at %s. If you moved or reinstalled it, open Runbooks and install the 'runbooks' command again.\\n" "$app" >&2`,
        "  exit 127",
        "fi",
        `for arg in "$@"; do`,
        `  if [ "$arg" = --verbose ]; then exec "$app" "$@"; fi`,
        "done",
        "trap '' HUP",
        "if command -v setsid >/dev/null 2>&1; then",
        `  setsid "$app" "$@" </dev/null >/dev/null 2>&1 &`,
        "else",
        `  if [ -n "\${BASH_VERSION-}" ]; then set -m; fi`,
        `  "$app" "$@" </dev/null >/dev/null 2>&1 &`,
        "fi",
        "",
      ].join("\n"),
    )
  })

  it("quotes a path with a single quote in it", () => {
    expect(shellSingleQuote("/Users/o'brien/Runbooks")).toBe("'/Users/o'\\''brien/Runbooks'")
    expect(renderUnixLauncher("/Users/o'brien/Runbooks")).toContain(`app='/Users/o'\\''brien/Runbooks'\n`)
  })

  // Arguments a shell would expand or split if the launcher mishandled them.
  const args = ["./my runbook.mdx", "*", "$HOME", "it's"]

  /** Writes a stand-in for the app at a path no shell would take unquoted. */
  function hostileApp(script: string): string {
    const appDir = nodePath.join(tmp, `My "Apps" it's $HOME \\ dir`)
    fs.mkdirSync(appDir)
    const target = nodePath.join(appDir, "Runbooks")
    fs.writeFileSync(target, script, { mode: 0o755 })
    return target
  }

  function writeLauncher(target: string): string {
    const launcher = nodePath.join(tmp, "runbooks")
    fs.writeFileSync(launcher, renderUnixLauncher(target), { mode: 0o755 })
    return launcher
  }

  it.skipIf(isWindows)(
    "starts the app in the background with its output discarded, and returns at once",
    async () => {
      const out = nodePath.join(tmp, "out")
      const hold = nodePath.join(tmp, "hold")
      // Stand-in for the app: writes to both streams, records where it ran and
      // what it was given, then keeps running while the hold file exists (for
      // 30 seconds at most, so a failed test cannot leave it behind for long).
      const target = hostileApp(
        [
          "#!/bin/sh",
          "echo out-noise",
          "echo err-noise >&2",
          `pwd -P > "$OUT.tmp"`,
          `for a in "$@"; do printf "%s\\n" "$a" >> "$OUT.tmp"; done`,
          `mv "$OUT.tmp" "$OUT"`,
          "i=0",
          `while [ -e "$HOLD" ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done`,
          "exit 7",
          "",
        ].join("\n"),
      )
      const launcher = writeLauncher(target)
      const workDir = nodePath.join(tmp, "work dir")
      fs.mkdirSync(workDir)
      fs.writeFileSync(hold, "")
      try {
        // Were the launcher to wait for the app, or hand it these pipes,
        // spawnSync would block while the stand-in holds and time out.
        const result = spawnSync(launcher, args, {
          cwd: workDir,
          env: { ...process.env, OUT: out, HOLD: hold },
          encoding: "utf8",
          timeout: 5_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("")
        expect(result.status).toBe(0)

        // The app got the caller's working directory, arguments and environment.
        const deadline = Date.now() + 5_000
        while (!fs.existsSync(out) && Date.now() < deadline) await Bun.sleep(20)
        expect(fs.readFileSync(out, "utf8")).toBe([workDir, ...args].map((l) => `${l}\n`).join(""))
      } finally {
        fs.rmSync(hold, { force: true })
      }
    },
    15_000,
  )

  // script(1) runs a command as the session leader of a new terminal, as a
  // VS Code task, `xterm -e runbooks .` or `tmux new-window 'runbooks .'` do.
  // When that leader exits, the kernel sends SIGHUP to the terminal's
  // foreground process group.
  const hasScript =
    !isWindows && spawnSync("/bin/sh", ["-c", "command -v script"], { env: process.env }).status === 0

  it.skipIf(!hasScript)(
    "puts the app in a process group of its own, which outlives a launcher that is a terminal's own command",
    async () => {
      const info = nodePath.join(tmp, "info")
      const go = nodePath.join(tmp, "go")
      const survived = nodePath.join(tmp, "survived")
      // Stand-in for the app: records its PID and process group, then waits
      // for the test's go-ahead (for 10 seconds at most) and records that it
      // was still running to get it.
      const target = hostileApp(
        [
          "#!/bin/sh",
          `echo "$$ $(ps -o pgid= -p $$)" > "$INFO.tmp"`,
          `mv "$INFO.tmp" "$INFO"`,
          "i=0",
          `while [ ! -e "$GO" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done`,
          `if [ -e "$GO" ]; then : > "$SURVIVED"; fi`,
          "",
        ].join("\n"),
      )
      const launcher = writeLauncher(target)
      // BSD script takes the command as arguments; util-linux script runs a
      // command line with $SHELL -c.
      const scriptArgs =
        process.platform === "darwin"
          ? ["-q", "/dev/null", launcher, "."]
          : ["-q", "-e", "-c", `${shellSingleQuote(launcher)} .`, "/dev/null"]
      try {
        const result = spawnSync("script", scriptArgs, {
          env: { ...process.env, SHELL: "/bin/sh", INFO: info, GO: go, SURVIVED: survived },
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          timeout: 10_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
      } finally {
        // The launcher has exited, so any SIGHUP its exit caused is already sent.
        fs.writeFileSync(go, "")
      }

      const deadline = Date.now() + 5_000
      while (!fs.existsSync(survived) && Date.now() < deadline) await Bun.sleep(20)
      expect({ survived: fs.existsSync(survived) }).toEqual({ survived: true })

      // Its own group, never the terminal's foreground one, so Ctrl+C in the
      // terminal does not reach it either.
      const [pid, pgid] = fs.readFileSync(info, "utf8").trim().split(/\s+/)
      expect(pgid).toBe(pid)
    },
    20_000,
  )

  it.skipIf(isWindows)(
    "--verbose runs the app in the foreground and passes output, arguments and exit code through",
    () => {
      // Stand-in for the app: prints each argument on its own line.
      const target = hostileApp(
        '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\necho err-noise >&2\nexit 7\n',
      )
      const launcher = writeLauncher(target)
      // Recognised anywhere, and passed on: the app ignores it (see below).
      const verboseArgs = [args[0], "--verbose", ...args.slice(1)]
      const result = spawnSync(launcher, verboseArgs, { encoding: "utf8", env: process.env })
      expect(result.stderr).toBe("err-noise\n")
      expect(result.stdout).toBe(verboseArgs.map((a) => `${a}\n`).join(""))
      expect(result.status).toBe(7)
    },
  )

  it.skipIf(isWindows)("reports a moved or deleted app instead of failing silently", () => {
    const target = nodePath.join(tmp, `Gone "Apps" it's $HOME`, "Runbooks")
    const launcher = writeLauncher(target)
    const result = spawnSync(launcher, ["."], { encoding: "utf8", env: process.env })
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`not found at ${target}.`)
    expect(result.stderr).toContain("install the 'runbooks' command again")
    expect(result.status).toBe(127)
  })
})

describe("the --verbose flag the launcher passes on", () => {
  it("is ignored by the app, never taken for a runbook", () => {
    const x = nodePath.join(tmp, "x")
    expect(parseCliArgs(["Runbooks", "--verbose", "./x"], tmp).runbookPath).toBe(x)
    expect(parseCliArgs(["Runbooks", "./x", "--verbose"], tmp).runbookPath).toBe(x)
    expect(parseCliArgs(["Runbooks", "open", "--verbose", "./x"], tmp).runbookPath).toBe(x)
    expect(parseCliArgs(["Runbooks", "--verbose"], tmp).runbookPath).toBeNull()
  })
})

describe("renderWindowsLauncher", () => {
  it("starts the executable by absolute path with CRLF line endings", () => {
    const text = renderWindowsLauncher("C:\\Program Files\\Runbooks\\Runbooks.exe", "C:\\Users\\dev\\AppData\\Local")
    expect(text).toBe(
      [
        "@echo off",
        `rem ${LAUNCHER_MARKER}`,
        "setlocal",
        // Look for --verbose with shift, not `for %%a in (%*)`, which would
        // expand the ? in a go-getter ?ref= as a wildcard. shift leaves %* alone.
        ":scan",
        'if "%~1"=="" goto detach',
        'if /i "%~1"=="--verbose" goto verbose',
        "shift",
        "goto scan",
        ":verbose",
        '"C:\\Program Files\\Runbooks\\Runbooks.exe" %*',
        "exit /b %ERRORLEVEL%",
        ":detach",
        'set "ELECTRON_NO_ATTACH_CONSOLE=1"',
        'start "" "C:\\Program Files\\Runbooks\\Runbooks.exe" %*',
        "",
      ].join("\r\n"),
    )
  })

  it("doubles a literal percent sign so cmd.exe does not expand it", () => {
    const text = renderWindowsLauncher("C:\\100%done\\Runbooks.exe")
    expect(text).toContain('\r\n"C:\\100%%done\\Runbooks.exe" %*\r\n')
    expect(text).toContain('\r\nstart "" "C:\\100%%done\\Runbooks.exe" %*\r\n')
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

  it("reports the foreground launcher earlier releases wrote as stale, so install offers to replace it", () => {
    const target = "/Applications/Runbooks.app/Contents/MacOS/Runbooks"
    const previous = ["#!/bin/sh", `# ${LAUNCHER_MARKER}`, `exec '${target}' "$@"`, ""].join("\n")
    expect(classifyLauncher({ present: true, content: previous }, renderUnixLauncher(target))).toBe("stale")

    const exe = "C:\\Program Files\\Runbooks\\Runbooks.exe"
    const previousWindows = ["@echo off", `rem ${LAUNCHER_MARKER}`, `"${exe}" %*`, ""].join("\r\n")
    expect(classifyLauncher({ present: true, content: previousWindows }, renderWindowsLauncher(exe))).toBe("stale")
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
      const result = spawnSync("osascript", ["-e", script], { encoding: "utf8", env: process.env })
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      expect(fs.statSync(launcher).mode & 0o777).toBe(0o755)
    },
  )
})
