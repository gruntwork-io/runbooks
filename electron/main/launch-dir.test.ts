import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import { parseCliArgs, secondInstanceArgv } from "./cli.ts"
import {
  launchDirContext,
  recoverLaunchDirectory,
  requestLaunchLock,
  secondInstanceLaunchDirectory,
  type LaunchLockData,
  type ProcessDirectory,
} from "./launch-dir.ts"

/** An error shaped like the one Node's process.cwd()/process.chdir() throw. */
function errnoError(code: string, syscall: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: ${syscall} failed`)
  err.code = code
  err.syscall = syscall
  return err
}

/**
 * A fake process directory. `cwd` undefined means the current directory can't
 * be read (it was deleted): cwd() throws `cwdError` until a chdir succeeds.
 * chdir() records every call and throws ENOENT for the dirs in `missing`.
 *
 * Deleting a real cwd can't stand in for this: bun caches process.cwd() and
 * refuses to start in a deleted directory, so only a fake reproduces the
 * throw Node and Electron's main process hit.
 */
function fakeProcess(opts: {
  cwd?: string
  cwdError?: string
  pwd?: string
  home?: string
  missing?: string[]
}): { proc: ProcessDirectory; chdirs: string[]; current: () => string | undefined } {
  const chdirs: string[] = []
  let current = opts.cwd
  const proc: ProcessDirectory = {
    cwd: () => {
      if (current === undefined) throw errnoError(opts.cwdError ?? "ENOENT", "uv_cwd")
      return current
    },
    chdir: (dir) => {
      chdirs.push(dir)
      if (opts.missing?.includes(dir)) throw errnoError("ENOENT", "chdir")
      current = dir
    },
    pwd: opts.pwd,
    home: opts.home ?? "/home/me",
  }
  return { proc, chdirs, current: () => current }
}

describe("recoverLaunchDirectory", () => {
  let warn: Mock<typeof console.warn>
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })
  const warnings = () => warn.mock.calls.map((args) => args.join(" "))

  it("returns a readable cwd and leaves the process where it is", () => {
    const { proc, chdirs } = fakeProcess({ cwd: "/work/here", pwd: "/somewhere/else" })
    expect(recoverLaunchDirectory(proc)).toBe("/work/here")
    expect(chdirs).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it("returns $PWD and moves to home when the cwd was deleted", () => {
    const { proc, chdirs, current } = fakeProcess({ pwd: "/work/gone" })
    expect(recoverLaunchDirectory(proc)).toBe("/work/gone")
    expect(chdirs).toEqual(["/home/me"])
    expect(current()).toBe("/home/me")
    // One line naming the missing folder and where the app runs from now.
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain("ENOENT")
    expect(warnings()[0]).toContain("/work/gone")
    expect(warnings()[0]).toContain("runs from /home/me")
  })

  it("returns home when $PWD is unset", () => {
    const { proc, chdirs } = fakeProcess({})
    expect(recoverLaunchDirectory(proc)).toBe("/home/me")
    expect(chdirs).toEqual(["/home/me"])
  })

  it("returns home when $PWD is relative", () => {
    // `zsh -c` started in a deleted folder exports PWD=".".
    const { proc, chdirs } = fakeProcess({ pwd: "." })
    expect(recoverLaunchDirectory(proc)).toBe("/home/me")
    expect(chdirs).toEqual(["/home/me"])
    // The warning says the folder is unknown, not just where paths now go.
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain("didn't say which folder")
    expect(warnings()[0]).toContain("home folder (/home/me)")
  })

  it("reads this process's real cwd when given no process", () => {
    expect(recoverLaunchDirectory()).toBe(process.cwd())
    expect(warn).not.toHaveBeenCalled()
  })

  it("falls back to / when home can't be entered", () => {
    const { proc, chdirs, current } = fakeProcess({ pwd: "/work/gone", missing: ["/home/me"] })
    expect(recoverLaunchDirectory(proc)).toBe("/work/gone")
    expect(chdirs).toEqual(["/home/me", "/"])
    expect(current()).toBe("/")
  })

  it("doesn't throw when no directory can be entered", () => {
    const { proc, chdirs } = fakeProcess({ pwd: "/work/gone", missing: ["/home/me", "/"] })
    expect(recoverLaunchDirectory(proc)).toBe("/work/gone")
    expect(chdirs).toEqual(["/home/me", "/"])
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain("couldn't move to another directory")
  })

  it("handles an unreadable cwd (EACCES) like a deleted one", () => {
    const { proc, chdirs } = fakeProcess({ cwdError: "EACCES", pwd: "/work/locked" })
    expect(recoverLaunchDirectory(proc)).toBe("/work/locked")
    expect(chdirs).toEqual(["/home/me"])
    expect(warnings()[0]).toContain("EACCES")
  })

  describe("with parseCliArgs", () => {
    const launch = () => recoverLaunchDirectory(fakeProcess({ pwd: "/work/gone" }).proc)

    it("resolves `.` against the deleted folder", () => {
      expect(parseCliArgs(["runbooks", "."], launch()).runbookPath).toBe("/work/gone")
    })

    it("resolves a relative path under the deleted folder", () => {
      expect(parseCliArgs(["runbooks", "./rb"], launch()).runbookPath).toBe("/work/gone/rb")
      expect(parseCliArgs(["runbooks", "open", "rb"], launch()).runbookPath).toBe("/work/gone/rb")
    })

    it("leaves an absolute path unchanged", () => {
      expect(parseCliArgs(["runbooks", "/abs/rb"], launch()).runbookPath).toBe("/abs/rb")
    })

    it("leaves a remote source unchanged", () => {
      const url = "https://github.com/org/repo/tree/main/runbooks/setup"
      const config = parseCliArgs(["runbooks", url], launch())
      expect(config.remoteUrl).toBe(url)
      expect(config.runbookPath).toBeNull()
    })

    it("resolves `.` against home when the shell didn't say which folder it was in", () => {
      const home = recoverLaunchDirectory(fakeProcess({ pwd: "." }).proc)
      expect(parseCliArgs(["runbooks", "."], home).runbookPath).toBe("/home/me")
    })
  })
})

describe("requestLaunchLock", () => {
  let warn: Mock<typeof console.warn>
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it("recovers the cwd before requesting the lock, and sends argv with the launch directory", () => {
    const { proc } = fakeProcess({ pwd: "/work/gone" })
    const argv = ["runbooks", "./rb"]
    let cwdAtLock: string | undefined
    let sent: LaunchLockData | undefined
    const result = requestLaunchLock(
      (data) => {
        // Chromium reads the cwd while taking the lock: it must be readable.
        cwdAtLock = proc.cwd()
        sent = data
        return false
      },
      argv,
      proc,
    )
    expect(cwdAtLock).toBe("/home/me")
    expect(sent).toEqual({ argv, cwd: "/work/gone" })
    expect(result).toEqual({ gotLock: false, launchDir: "/work/gone" })
  })

  it("returns the lock and the live cwd when nothing needs recovering", () => {
    const { proc, chdirs } = fakeProcess({ cwd: "/work/here" })
    const result = requestLaunchLock(() => true, ["runbooks"], proc)
    expect(result).toEqual({ gotLock: true, launchDir: "/work/here" })
    expect(chdirs).toEqual([])
  })

  it("lets the running app resolve a second instance's relative path against its deleted folder", () => {
    // The second instance, run from a deleted folder, has moved to home, so
    // Electron reports home as its workingDirectory.
    const { proc } = fakeProcess({ pwd: "/work/gone" })
    let sent: unknown
    requestLaunchLock(
      (data) => {
        sent = data
        return false
      },
      ["runbooks", "open", "./rb"],
      proc,
    )
    const workingDirectory = proc.cwd()
    const chromiumArgv = ["/Applications/Runbooks", "--some-switch", "open", "./rb"]
    const config = parseCliArgs(
      secondInstanceArgv(chromiumArgv, sent),
      secondInstanceLaunchDirectory(workingDirectory, sent),
    )
    expect(config.runbookPath).toBe("/work/gone/rb")
  })
})

describe("secondInstanceLaunchDirectory", () => {
  it("prefers the directory the second instance forwarded", () => {
    const data = { argv: ["runbooks", "."], cwd: "/work/gone" }
    expect(secondInstanceLaunchDirectory("/home/me", data)).toBe("/work/gone")
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["a non-string cwd", { cwd: 42 }],
    ["a relative cwd", { cwd: "relative/dir" }],
    ["an older sender's argv only", { argv: ["runbooks", "."] }],
  ])("falls back to Electron's workingDirectory for %s", (_label, data) => {
    expect(secondInstanceLaunchDirectory("/work/live", data)).toBe("/work/live")
  })
})

describe("launchDirContext", () => {
  const desktop = { home: "/home/me", appDir: "/opt/Runbooks" }

  it("is the directory `runbooks` was run in", () => {
    expect(launchDirContext("/home/me/project", desktop)).toBe("/home/me/project")
    expect(launchDirContext("/home/me/project/", desktop)).toBe("/home/me/project")
  })

  it.each([
    ["the filesystem root, where macOS starts an app opened from the dock", "/"],
    ["the home directory, where Linux desktops start an app", "/home/me"],
    ["the home directory with a trailing slash", "/home/me/"],
    ["the app's own folder, where a Windows shortcut starts it", "/opt/Runbooks"],
  ])("is undefined for %s", (_label, dir) => {
    expect(launchDirContext(dir, desktop)).toBeUndefined()
  })

  it("knows this machine's home directory and the app's folder", () => {
    expect(launchDirContext(os.homedir())).toBeUndefined()
    expect(launchDirContext(path.dirname(process.execPath))).toBeUndefined()
    expect(launchDirContext(path.join(os.homedir(), "project"))).toBe(
      path.join(os.homedir(), "project"),
    )
  })
})
