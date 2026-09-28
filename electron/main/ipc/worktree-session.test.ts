/**
 * Worktree registration against a runbook switch.
 *
 * git:local-repo, workspace:register and workspace:set-active each register a
 * worktree with the session after an await (git inspection, symlink-resolved
 * containment). If a different runbook opens during that await, the checkout
 * belongs to a block that is gone and must not become the new runbook's active
 * worktree (REPO_FILES, target="worktree" templates).
 *
 * Runs the real handlers, session manager and git against a temp repo; only
 * `electron` is replaced.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { mockElectron } from "../test-utils/mock-electron.ts"

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()

mockElectron({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
})

const { registerGitHandlers } = await import("./git.ts")
const { registerWorkspaceHandlers } = await import("./workspace.ts")
const { runtime, sessionManager } = await import("./runtime.ts")
const { makeTestEnvironment } = await import("../../../src/test-utils/TestEnvironment.ts")

registerGitHandlers()
registerWorkspaceHandlers()

const invoke = (channel: string, params?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, params)) as Promise<any>
}

let root = ""
let runbookA = ""
let runbookB = ""
let repoInA = ""

/** What runbook:get does when a different runbook is opened. */
const openRunbook = (dir: string) =>
  Effect.runPromise(
    sessionManager
      .createSession(dir, path.join(dir, "runbook.mdx"))
      .pipe(Effect.provide(makeTestEnvironment({}))),
  )

beforeAll(async () => {
  // Build the app runtime up front, as the running app has by the time a
  // block can call these handlers.
  await runtime.runPromise(Effect.void)
})

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-worktree-session-")))
  runbookA = path.join(root, "a")
  runbookB = path.join(root, "b")
  repoInA = path.join(runbookA, "repo")
  fs.mkdirSync(repoInA, { recursive: true })
  fs.mkdirSync(runbookB)
  execFileSync("git", ["init", "-q", repoInA])
  await openRunbook(runbookA)
})

afterEach(() => {
  sessionManager.deleteSession()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("git:local-repo", () => {
  it("a checkout picked in runbook A is not registered once runbook B has opened", async () => {
    const pending = invoke("git:local-repo", { path: repoInA, register: true })
    await openRunbook(runbookB)
    const result = await pending

    expect(result.status).toBe("success")
    expect(sessionManager.getActiveWorkTreePath()).toBe("")
  })

  it("without a switch, the checkout becomes the active worktree", async () => {
    const result = await invoke("git:local-repo", { path: repoInA, register: true })

    expect(result.status).toBe("success")
    expect(sessionManager.getActiveWorkTreePath()).toBe(result.absolutePath)
  })
})

describe("workspace:register / workspace:set-active", () => {
  it.each(["workspace:register", "workspace:set-active"])(
    "%s from runbook A does not reach runbook B's session",
    async (channel) => {
      const pending = invoke(channel, { worktreePath: repoInA })
      await openRunbook(runbookB)
      await pending

      expect(sessionManager.getActiveWorkTreePath()).toBe("")
      // B's own registration still works afterwards.
      const repoInB = path.join(runbookB, "repo")
      fs.mkdirSync(repoInB)
      await invoke("workspace:register", { worktreePath: repoInB })
      expect(sessionManager.getActiveWorkTreePath()).toBe(repoInB)
    },
  )
})
