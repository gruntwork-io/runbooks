import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

// git.ts registers its handlers on electron's ipcMain. Capture them so the
// real git:clone / git:clone-cancel handlers can be called directly; the rest
// of the stack (Effect runtime, session, process spawning, git itself) is the
// live one. Only the GitHub API is stubbed, through fetch.
type Handler = (event: unknown, params: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
})

const { registerGitHandlers } = await import("./git.ts")
const { runtime, sessionManager } = await import("./runtime.ts")

// A github.com URL, so that with a token the clone looks the repository up on
// the GitHub API once git is done. git's url.<base>.insteadOf (set through
// GIT_CONFIG_* in the environment the handler spawns git with) redirects it
// to a local repository.
const REMOTE_URL = "https://github.com/acme/infra.git"
const SANDBOX_VARS = [
  "HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
] as const

let tmpDir = ""
let workDir = ""
const originalEnv: Record<string, string | undefined> = {}
const originalFetch = globalThis.fetch

// `env: process.env` because bun's child_process otherwise starts git with the
// environment the test process began with, not the sandbox set up below.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
    env: process.env,
  })

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-clone-late-cancel-"))
  workDir = path.join(tmpDir, "work")
  fs.mkdirSync(workDir)

  // git runs with a sandboxed HOME and no global or system config.
  for (const name of SANDBOX_VARS) originalEnv[name] = process.env[name]
  const home = path.join(tmpDir, "home")
  fs.mkdirSync(home)
  process.env.HOME = home
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"
  process.env.GIT_CONFIG_SYSTEM = "/dev/null"

  const origin = path.join(tmpDir, "origin")
  fs.mkdirSync(origin)
  fs.writeFileSync(path.join(origin, "README.md"), "# infra\n")
  git(origin, "init", "-q", "-b", "main")
  git(origin, "add", ".")
  git(origin, "commit", "-q", "-m", "init")

  process.env.GIT_CONFIG_COUNT = "1"
  process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = REMOTE_URL

  await runtime.runPromise(sessionManager.createSession(workDir))
  registerGitHandlers()
})

afterAll(() => {
  for (const name of SANDBOX_VARS) {
    if (originalEnv[name] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[name]
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// The GitHub repo lookup that follows the clone never answers, like a slow
// API, so the clone is still in flight after git has finished.
let lookupStarted = false
beforeEach(() => {
  lookupStarted = false
  globalThis.fetch = (() => {
    lookupStarted = true
    return new Promise<Response>(() => {})
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const event = { sender: { send: () => {} } }
const startClone = (params: Record<string, unknown>) =>
  handlers.get("git:clone")!(event, {
    url: REMOTE_URL,
    provider: "github",
    credentials: { token: "ghp_test" },
    ...params,
  })
const cancel = (cloneId: string) => handlers.get("git:clone-cancel")!(null, { cloneId })
const registeredWorkTrees = async () =>
  (await runtime.runPromise(sessionManager.getSession())).registeredWorkTreePaths

describe("git:clone-cancel after git has finished", () => {
  it("leaves no worktree registered and no checkout behind", async () => {
    const dest = path.join(workDir, "late")
    const clone = startClone({ localPath: "late", cloneId: "late-1" })

    // The checkout is complete once the repo lookup starts.
    await waitFor(() => lookupStarted)
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true)

    await cancel("late-1")

    await expect(clone).resolves.toEqual({ status: "cancelled" })
    // A cancelled clone must not become the fallback active worktree, which
    // $REPO_FILES and target="worktree" writes would then use.
    expect(await registeredWorkTrees()).toEqual([])
    expect(sessionManager.getActiveWorkTreePath()).toBe("")
    expect(fs.existsSync(dest)).toBe(false)
  }, 20_000)

  it("removes only the directory the clone created", async () => {
    const parent = path.join(workDir, "existing")
    fs.mkdirSync(parent)
    fs.writeFileSync(path.join(parent, "keep.txt"), "keep\n")
    const clone = startClone({ localPath: "existing/late", cloneId: "late-2" })

    await waitFor(() => lookupStarted)
    await cancel("late-2")

    await expect(clone).resolves.toEqual({ status: "cancelled" })
    expect(fs.existsSync(path.join(parent, "late"))).toBe(false)
    expect(fs.readFileSync(path.join(parent, "keep.txt"), "utf-8")).toBe("keep\n")
  }, 20_000)

  it("still registers the worktree of a clone that is not cancelled", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch

    const result = await startClone({ localPath: "done", cloneId: "done-1" })

    expect(result).toMatchObject({ status: "success" })
    const { absolutePath } = result as { absolutePath: string }
    expect(await registeredWorkTrees()).toEqual([absolutePath])
    expect(fs.existsSync(path.join(absolutePath, "README.md"))).toBe(true)
  }, 20_000)
})
