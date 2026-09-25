import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// git.ts registers its handlers on electron's ipcMain. Capture them so the
// real git:clone handler can be called directly; the rest of the stack
// (Effect runtime, session, process spawning, git itself) is the live one.
// bun shares module mocks between test files and can't add an export to one
// already loaded, so this declares the same exports as theme-store.test.ts.
type Handler = (event: unknown, params: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mock.module("electron", () => ({
  app: {
    getPath: (name: string) => {
      throw new Error(`unexpected app.getPath(${name})`)
    },
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
}))

const { registerGitHandlers } = await import("./git.ts")
const { runtime, sessionManager } = await import("./runtime.ts")

// git:clone only accepts http(s) and SSH URLs, so the test clones these and
// git's url.<base>.insteadOf (set through GIT_CONFIG_* in the environment the
// handler spawns git with) redirects them to local repositories.
const REMOTE_URL = "https://git.example.com/acme/mono.git"
const EMPTY_REMOTE_URL = "https://git.example.com/acme/empty.git"
const GIT_CONFIG_VARS = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_VALUE_1",
] as const

let tmpDir = ""
let workDir = ""
const originalEnv: Record<string, string | undefined> = {}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
  })

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-clone-repo-path-"))
  workDir = path.join(tmpDir, "work")
  fs.mkdirSync(workDir)

  // A small monorepo whose `release` branch has a file `main` lacks.
  const origin = path.join(tmpDir, "origin")
  fs.mkdirSync(path.join(origin, "modules", "vpc"), { recursive: true })
  fs.mkdirSync(path.join(origin, "modules", "eks"), { recursive: true })
  fs.writeFileSync(path.join(origin, "README.md"), "# mono\n")
  fs.writeFileSync(path.join(origin, "modules", "vpc", "main.tf"), "# vpc\n")
  fs.writeFileSync(path.join(origin, "modules", "eks", "main.tf"), "# eks\n")
  git(origin, "init", "-q", "-b", "main")
  // Serve the blobless clone the sparse steps ask for, as GitHub/GitLab do.
  git(origin, "config", "uploadpack.allowFilter", "true")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "init")
  git(origin, "checkout", "-q", "-b", "release")
  fs.writeFileSync(path.join(origin, "modules", "vpc", "release.tf"), "# release\n")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "release")
  git(origin, "checkout", "-q", "main")

  // A repository that was created but never pushed to.
  const emptyOrigin = path.join(tmpDir, "empty.git")
  git(tmpDir, "init", "-q", "--bare", "-b", "main", emptyOrigin)

  for (const name of GIT_CONFIG_VARS) originalEnv[name] = process.env[name]
  process.env.GIT_CONFIG_COUNT = "2"
  process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = REMOTE_URL
  process.env.GIT_CONFIG_KEY_1 = `url.file://${emptyOrigin}.insteadOf`
  process.env.GIT_CONFIG_VALUE_1 = EMPTY_REMOTE_URL

  await runtime.runPromise(sessionManager.createSession(workDir))
  registerGitHandlers()
})

afterAll(() => {
  for (const name of GIT_CONFIG_VARS) {
    if (originalEnv[name] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[name]
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const event = { sender: { send: () => {} } }
const clone = (params: Record<string, unknown>) =>
  handlers.get("git:clone")!(event, { url: REMOTE_URL, ...params })

describe("git:clone repo_path", () => {
  it("checks out only the repo path, at the requested ref", async () => {
    const result = await clone({ localPath: "sparse", ref: "release", repo_path: "modules/vpc/" })

    expect(result).toMatchObject({ status: "success", ref: "release" })
    const dest = path.join(workDir, "sparse")
    // The ref is honored: this file exists only on `release`.
    expect(fs.existsSync(path.join(dest, "modules", "vpc", "release.tf"))).toBe(true)
    // Sibling directories stay out; cone mode keeps the root's own files.
    expect(fs.existsSync(path.join(dest, "modules", "eks"))).toBe(false)
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true)
  })

  it('clones the whole repository for "."', async () => {
    const result = await clone({ localPath: "whole", repo_path: "." })

    expect(result).toMatchObject({ status: "success", ref: "main" })
    expect(fs.existsSync(path.join(workDir, "whole", "modules", "eks", "main.tf"))).toBe(true)
  })

  it("reports a repository with no commits as empty instead of failing the checkout", async () => {
    const result = await clone({ url: EMPTY_REMOTE_URL, localPath: "empty", repo_path: "modules/vpc" })

    // The same result as without a repo path, so the block offers to seed the
    // default branch rather than showing an error.
    expect(result).toMatchObject({ status: "success", hasCommits: false, ref: "main" })
    expect(fs.existsSync(path.join(workDir, "empty", ".git"))).toBe(true)
  })

  it("rejects a repo path outside the repository before deleting the destination", async () => {
    const dest = path.join(workDir, "existing")
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, "keep.txt"), "keep\n")

    await expect(
      clone({ localPath: "existing", repo_path: "../outside", force: true }),
    ).rejects.toThrow(/invalid repo path/)
    expect(fs.existsSync(path.join(dest, "keep.txt"))).toBe(true)
  })
})
