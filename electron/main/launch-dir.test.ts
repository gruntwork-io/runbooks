import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test"
import { parseCliArgs } from "./cli.ts"
import {
  recoverLaunchDirectory,
  secondInstanceLaunchDirectory,
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
    const { proc, chdirs } = fakeProcess({ pwd: "gone" })
    expect(recoverLaunchDirectory(proc)).toBe("/home/me")
    expect(chdirs).toEqual(["/home/me"])
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
