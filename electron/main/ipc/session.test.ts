import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

// session.ts imports electron's `ipcMain` only to register handlers. Capture
// them so the test can call a handler the way the renderer's invoke would.
type Handler = (event: unknown, params?: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
})

const { registerSessionHandlers } = await import("./session.ts")
const { runtime, saveVcsSessionMeta, sessionManager, vcsSessionMeta } = await import("./runtime.ts")
const { installTestSessionPersistence } = await import("../test-utils/session-persistence.ts")

registerSessionHandlers()

const sessionEnv = async () =>
  Object.fromEntries((await runtime.runPromise(sessionManager.getSession())).env)

describe("session IPC handlers", () => {
  let tmpDir = ""

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-session-ipc-"))
    await runtime.runPromise(sessionManager.createSession(tmpDir))
  })

  afterEach(() => {
    sessionManager.deleteSession()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Both channels declare { ok: true }; the handlers returned nothing.
  it("session:set-env adds the vars and returns { ok: true }", async () => {
    const result = await handlers.get("session:set-env")!(undefined, {
      env: { RUNBOOKS_TEST_VAR: "set" },
    })

    expect(result).toEqual({ ok: true })
    expect((await sessionEnv()).RUNBOOKS_TEST_VAR).toBe("set")
  })

  it("session:reset restores the initial env and returns { ok: true }", async () => {
    await handlers.get("session:set-env")!(undefined, { env: { RUNBOOKS_TEST_VAR: "set" } })

    const result = await handlers.get("session:reset")!(undefined)

    expect(result).toEqual({ ok: true })
    expect((await sessionEnv()).RUNBOOKS_TEST_VAR).toBeUndefined()
  })

  describe("on the open runbook's saved session", () => {
    let sessions: ReturnType<typeof installTestSessionPersistence>

    const rename = (params?: unknown) =>
      handlers.get("session:rename")!(undefined, params) as Promise<{ name: string }>

    const recordEvent = (params?: unknown) =>
      handlers.get("session:record-event")!(undefined, params)

    const blockStates = () => runtime.runPromise(sessions.persistence.blockStates())

    /** Open a runbook's session the way runbook:get does. */
    const openSession = (runbookPath: string) =>
      runtime.runPromise(
        sessions.persistence.open({
          runbook: { path: runbookPath, remoteSource: undefined },
          launchDir: undefined,
          sessionId: undefined,
          startNew: false,
        }),
      )

    beforeEach(() => {
      sessions = installTestSessionPersistence()
    })

    afterEach(() => {
      sessions.cleanup()
    })

    it("session:reset drops the session's git host bindings, saved ones included", async () => {
      const session = await openSession("/repo/runbook.mdx")
      vcsSessionMeta.set("gitlab", { host: "gitlab.com", source: "manual" })
      saveVcsSessionMeta()

      await handlers.get("session:reset")!(undefined)

      expect(vcsSessionMeta.size).toBe(0)
      expect((await runtime.runPromise(sessions.store.get(session.id)))?.vcsBindings).toEqual({})
    })

    it("session:rename renames the open session and returns its new name", async () => {
      const session = await openSession("/repo/runbook.mdx")

      expect(await rename({ name: " prod-deploy " })).toEqual({ name: "prod-deploy" })

      expect(sessions.persistence.currentSession()?.name).toBe("prod-deploy")
      expect((await runtime.runPromise(sessions.store.get(session.id)))?.name).toBe("prod-deploy")
    })

    it("session:rename rejects a name that is not allowed with the reason, and keeps the old name", async () => {
      const session = await openSession("/repo/runbook.mdx")

      await expect(rename({ name: "Prod Deploy" })).rejects.toThrow(
        /Use lowercase letters, digits and hyphens/,
      )
      await expect(rename({ name: "a".repeat(64) })).rejects.toThrow(/at most 63 characters/)
      // What a renderer that sends no name, or not a string, gets.
      await expect(rename(undefined)).rejects.toThrow(/Enter a name/)
      await expect(rename({ name: 42 })).rejects.toThrow(/Enter a name/)

      expect(sessions.persistence.currentSession()?.name).toBe(session.name)
    })

    it("session:rename rejects another session's name", async () => {
      const other = await openSession("/other/runbook.mdx")
      await openSession("/repo/runbook.mdx")

      await expect(rename({ name: other.name })).rejects.toThrow(
        `Another session is already named ${other.name}.`,
      )
    })

    it("session:record-event adds the event to the session's history and returns { ok: true }", async () => {
      const session = await openSession("/repo/runbook.mdx")
      const payload = { values: { region: "us-east-1" }, submitted: true }

      const result = await recordEvent({
        sessionId: session.id,
        blockId: "config",
        kind: "inputs",
        payload,
      })

      expect(result).toEqual({ ok: true })
      expect(await blockStates()).toEqual([{ blockId: "config", kind: "inputs", payload }])
    })

    it("session:record-event drops an event of a session that is not the open one", async () => {
      const other = await openSession("/other/runbook.mdx")
      await openSession("/repo/runbook.mdx")

      const result = await recordEvent({
        sessionId: other.id,
        blockId: "config",
        kind: "inputs",
        payload: { values: {}, submitted: false },
      })

      expect(result).toEqual({ ok: true })
      expect(await blockStates()).toEqual([])
    })

    it("session:record-event rejects what is not an event, and saves nothing", async () => {
      const session = await openSession("/repo/runbook.mdx")

      await expect(recordEvent(undefined)).rejects.toThrow(/the id of its session/)
      await expect(recordEvent({ blockId: "config", kind: "inputs", payload: {} })).rejects.toThrow(
        /the id of its session/,
      )
      await expect(
        recordEvent({ sessionId: session.id, blockId: "config", kind: "env", payload: {} }),
      ).rejects.toThrow(/must be one of inputs, run, render, clone, pull-request, auth/)
      await expect(
        recordEvent({ sessionId: session.id, blockId: "config", kind: "inputs" }),
      ).rejects.toThrow(/a payload that is not JSON/)

      expect(await blockStates()).toEqual([])
    })
  })
})
