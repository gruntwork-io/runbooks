/**
 * session:list, session:switch and session:delete on the real handlers and
 * runtime: runbook:get loads runbooks into saved sessions, and a switch is
 * checked by what main sends the renderer and by what the renderer's next
 * runbook:get then resumes. Only electron and the main window are faked.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, mock, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

type Handler = (event: unknown, params?: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
})

// What main sends the renderer.
const sent: Array<{ channel: string; payload: unknown }> = []
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    isLoading: () => false,
    send: (channel: string, payload?: unknown) => {
      sent.push({ channel, payload })
    },
  },
}
await mock.module("../window.ts", () => ({ getMainWindow: () => fakeWindow }))

const { registerRunbookHandlers, markRunbookClosed, resetToNewSession } =
  await import("./runbook.ts")
const { registerSessionHandlers } = await import("./session.ts")
const { registerExecHandlers, isExecutionRunning } = await import("./exec.ts")
const { stopWatchers } = await import("./watch.ts")
const runtimeModule = await import("./runtime.ts")
const remoteModule = await import("../remote.ts")
const { installTestSessionPersistence } = await import("../test-utils/session-persistence.ts")
const { sessionManager, setExecutableRegistry, setRunbookConfig } = runtimeModule

type Loaded = { path: string; sessionId: string; sessionName: string }
type Listed = { id: string; isCurrent: boolean; runbookMissing: boolean; finishedAt?: string }

const invoke = (channel: string, params?: unknown) => handlers.get(channel)!(undefined, params)
const getRunbook = (runbookPath: string, remoteSource?: string) =>
  invoke("runbook:get", {
    path: runbookPath,
    ...(remoteSource ? { remoteSource } : {}),
  }) as Promise<Loaded>
const switchTo = (id: string, stopRunningScript?: boolean) =>
  invoke("session:switch", { id, ...(stopRunningScript ? { stopRunningScript } : {}) })
const list = async () => ((await invoke("session:list")) as { sessions: Listed[] }).sessions

/** The runbooks main asked the renderer to open since `from`. */
const opensSince = (from: number) =>
  sent
    .slice(from)
    .filter((m) => m.channel === "file:open-runbook")
    .map((m) => m.payload)

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  return true
}

describe("switching and deleting saved sessions", () => {
  let tmp: string
  let dirA: string
  let dirB: string
  let sessions: ReturnType<typeof installTestSessionPersistence>
  const originalRunbookConfig = runtimeModule.runbookConfig
  const spies: Array<{ mockRestore: () => void }> = []

  beforeAll(() => {
    registerRunbookHandlers()
    registerSessionHandlers()
    registerExecHandlers()
  })

  beforeEach(() => {
    sessions = installTestSessionPersistence()
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-switch-")))
    dirA = path.join(tmp, "a")
    dirB = path.join(tmp, "b")
    for (const dir of [dirA, dirB]) {
      fs.mkdirSync(dir)
      fs.writeFileSync(
        path.join(dir, "runbook.mdx"),
        `# Runbook\n\n<Command id="long" command="sleep 30" />\n`,
      )
    }
  })

  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore()
    await stopWatchers()
    markRunbookClosed()
    sessionManager.deleteSession()
    setExecutableRegistry(null)
    setRunbookConfig(originalRunbookConfig)
    sessions.cleanup()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const sessionEnv = async () =>
    (await runtimeModule.runtime.runPromise(sessionManager.getExecContext())).env

  describe("session:list", () => {
    it("lists the saved sessions, most recently used first, with the open one marked", async () => {
      const a = await getRunbook(dirA)
      const b = await getRunbook(dirB)

      const listed = await list()

      expect(listed.map((s) => [s.id, s.isCurrent, s.runbookMissing])).toEqual([
        [b.sessionId, true, false],
        [a.sessionId, false, false],
      ])
    })
  })

  describe("session:switch", () => {
    it("opens another runbook's session, which runbook:get then resumes", async () => {
      const a = await getRunbook(dirA)
      await runtimeModule.runtime.runPromise(sessionManager.appendToEnv({ FROM_A: "1" }))
      await getRunbook(dirB)
      const from = sent.length

      expect(await switchTo(a.sessionId)).toEqual({ status: "switched" })

      expect(opensSince(from)).toEqual([{ path: a.path }])
      // Launch times have millisecond resolution: let B's launch be the earlier one.
      await new Promise((resolve) => {
        setTimeout(resolve, 5)
      })
      const resumed = await getRunbook(a.path)
      expect(resumed.sessionId).toBe(a.sessionId)
      expect((await sessionEnv()).FROM_A).toBe("1")
      // It counts as launched again: a launch from the dock resumes it next.
      expect(
        (await runtimeModule.runtime.runPromise(sessions.persistence.findForLaunch(undefined)))?.id,
      ).toBe(a.sessionId)
    })

    it("opens an older session of the open runbook", async () => {
      const older = await getRunbook(dirA)
      resetToNewSession()
      const newer = await getRunbook(older.path)
      const from = sent.length

      expect(await switchTo(older.sessionId)).toEqual({ status: "switched" })

      expect(opensSince(from)).toEqual([{ path: older.path }])
      expect((await getRunbook(older.path)).sessionId).toBe(older.sessionId)
      // The switch applied to one load: reloading keeps the session it opened.
      expect((await getRunbook(older.path)).sessionId).toBe(older.sessionId)
      expect(newer.sessionId).not.toBe(older.sessionId)
    })

    it("does nothing for the open session", async () => {
      const a = await getRunbook(dirA)
      const from = sent.length

      expect(await switchTo(a.sessionId)).toEqual({ status: "switched" })

      expect(opensSince(from)).toEqual([])
    })

    it("fails, opening nothing, for a session that no longer exists or whose runbook is gone", async () => {
      const a = await getRunbook(dirA)
      await getRunbook(dirB)
      fs.rmSync(dirA, { recursive: true })
      const from = sent.length

      expect(await switchTo("01900000-0000-7000-8000-000000000000")).toEqual({
        status: "failed",
        error: "This session no longer exists.",
      })
      expect(await switchTo(a.sessionId)).toEqual({
        status: "failed",
        error: `This session's runbook is gone: ${a.path}`,
      })
      expect(opensSince(from)).toEqual([])
      expect((await list()).find((s) => s.id === a.sessionId)?.runbookMissing).toBe(true)
    })

    it("clones a remote runbook again, though its last clone is gone, and opens it in its session", async () => {
      const url = "https://github.com/acme/runbooks//a"
      const a = await getRunbook(dirA, url)
      await getRunbook(dirB)
      const clone = path.join(tmp, "clone")
      fs.cpSync(dirA, clone, { recursive: true })
      // Clones are temporary: the one the session last used was deleted.
      fs.rmSync(dirA, { recursive: true })
      const resolve = spyOn(remoteModule, "resolveRemoteRunbook").mockResolvedValue({
        localPath: path.join(clone, "runbook.mdx"),
        remoteSource: url,
      })
      spies.push(resolve)
      const from = sent.length

      expect(await switchTo(a.sessionId)).toEqual({ status: "switched" })

      expect(resolve).toHaveBeenCalledWith(url)
      expect(opensSince(from)).toEqual([
        { path: path.join(clone, "runbook.mdx"), remoteSource: url },
      ])
      expect((await getRunbook(path.join(clone, "runbook.mdx"), url)).sessionId).toBe(a.sessionId)
    })

    it("says why a remote runbook couldn't be cloned, without its token, and opens nothing", async () => {
      const url = "https://github.com/acme/runbooks//a"
      const a = await getRunbook(dirA, url)
      await getRunbook(dirB)
      const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz"
      spies.push(
        spyOn(remoteModule, "resolveRemoteRunbook").mockRejectedValue(
          new Error(`clone failed with ${token}: repository not found`),
        ),
      )
      const from = sent.length

      const result = (await switchTo(a.sessionId)) as { status: string; error: string }

      expect(result.status).toBe("failed")
      expect(result.error).toContain("repository not found")
      expect(result.error).not.toContain(token)
      expect(opensSince(from)).toEqual([])
    })

    it("asks before stopping a running script, and stops it when told to", async () => {
      const a = await getRunbook(dirA)
      await getRunbook(dirB)
      const executableId = Object.keys(runtimeModule.executableRegistry!.getAllExecutables())[0]!
      const run = handlers.get("exec:run")!(
        { sender: { send: () => {} } },
        { executableId, executionId: "long-run" },
      )
      expect(await waitUntil(isExecutionRunning, 5000)).toBe(true)
      const from = sent.length

      expect(await switchTo(a.sessionId)).toEqual({ status: "script-running" })
      expect(opensSince(from)).toEqual([])
      expect(isExecutionRunning()).toBe(true)

      expect(await switchTo(a.sessionId, true)).toEqual({ status: "switched" })
      expect(await run).toMatchObject({ cancelled: true })
      expect(isExecutionRunning()).toBe(false)
      expect(opensSince(from)).toEqual([{ path: a.path }])
    })

    it("rejects a request with no session id", async () => {
      await expect(invoke("session:switch", {})).rejects.toThrow(
        "a session switch needs a session id",
      )
    })
  })

  describe("session:finish", () => {
    it("marks the open session finished: the runbook's next open starts a new one", async () => {
      const a = await getRunbook(dirA)

      expect(await invoke("session:finish")).toEqual({ ok: true })

      expect((await list()).find((s) => s.id === a.sessionId)).toMatchObject({
        finishedAt: expect.any(String),
      })
      // A restart, then the runbook is opened again.
      markRunbookClosed()
      sessionManager.deleteSession()
      const next = await getRunbook(dirA)
      expect(next.sessionId).not.toBe(a.sessionId)
      // Switching to the finished session still opens it.
      expect(await switchTo(a.sessionId)).toEqual({ status: "switched" })
      expect((await getRunbook(a.path)).sessionId).toBe(a.sessionId)
    })
  })

  describe("session:delete", () => {
    it("deletes another session and its directory", async () => {
      const a = await getRunbook(dirA)
      const b = await getRunbook(dirB)
      const dirOfA = path.join(sessions.dirsRoot, a.sessionId)

      expect(await invoke("session:delete", { id: a.sessionId })).toEqual({ ok: true })

      expect(fs.existsSync(dirOfA)).toBe(false)
      expect((await list()).map((s) => s.id)).toEqual([b.sessionId])
    })

    it("refuses to delete the open session, and says why", async () => {
      const a = await getRunbook(dirA)

      await expect(invoke("session:delete", { id: a.sessionId })).rejects.toThrow(
        "Switch to another session before deleting it.",
      )
      expect((await list()).map((s) => s.id)).toEqual([a.sessionId])
    })

    it("rejects a request with no session id", async () => {
      await expect(invoke("session:delete", { id: 7 })).rejects.toThrow(
        "a session delete needs a session id",
      )
    })
  })
})
