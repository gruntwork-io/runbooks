import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { gitCloneArgs } from "./clone-args.ts"

// These tests spawn real git/ssh processes, which a loaded full-suite run can
// stall past bun's 5 s default; 30 s matches the other real-git tests.
setDefaultTimeout(30_000)

describe("gitCloneArgs", () => {
  it("ends option parsing before the URL and destination", () => {
    expect(gitCloneArgs("https://github.com/o/r.git", "/work/r")).toEqual([
      "clone",
      "--progress",
      "--",
      "https://github.com/o/r.git",
      "/work/r",
    ])
  })

  it("passes the ref as the value of --branch, before --", () => {
    expect(gitCloneArgs("git@github.com:o/r.git", "/work/r", { ref: "v1.2.3" })).toEqual([
      "clone",
      "--progress",
      "--branch",
      "v1.2.3",
      "--",
      "git@github.com:o/r.git",
      "/work/r",
    ])
  })

  it("clones blobless without a checkout for a sparse checkout", () => {
    expect(gitCloneArgs("https://github.com/o/r.git", "/work/r", { sparse: true })).toEqual([
      "clone",
      "--progress",
      "--filter=blob:none",
      "--no-checkout",
      "--",
      "https://github.com/o/r.git",
      "/work/r",
    ])
  })
})

// Real git: an option-like URL or ref must never run the command it smuggles.
describe("gitCloneArgs (real git)", () => {
  let tmp: string
  let source: string
  let marker: string

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd,
      stdio: "pipe",
    })

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-clone-args-"))
    source = path.join(tmp, "source")
    fs.mkdirSync(source)
    git(source, "init", "-q")
    git(source, "commit", "-q", "--allow-empty", "-m", "initial")
    marker = path.join(tmp, "pwned")
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it.each([
    ["--upload-pack", (m: string) => `--upload-pack=touch ${m}; git-upload-pack`],
    ["-u", (m: string) => `-utouch ${m}; git-upload-pack`],
  ])("takes a %s URL as the repository, not an option", (_label, makeUrl) => {
    // Without `--` the URL is an option and `source` becomes the repository,
    // cloned by running the smuggled upload-pack command.
    expect(() => git(tmp, ...gitCloneArgs(makeUrl(marker), source))).toThrow(/does not exist/)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it("takes an option-like ref as the branch name", () => {
    const dest = path.join(tmp, "dest")
    const ref = `--upload-pack=touch ${marker}; git-upload-pack`
    expect(() => git(tmp, ...gitCloneArgs(`file://${source}`, dest, { ref }))).toThrow(/not found/)
    expect(fs.existsSync(marker)).toBe(false)
  })
})
