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
const { runtime, sessionManager } = await import("./runtime.ts")
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

  describe("session:rename", () => {
    let sessions: ReturnType<typeof installTestSessionPersistence>

    const rename = (params?: unknown) =>
      handlers.get("session:rename")!(undefined, params) as Promise<{ name: string }>

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

    it("renames the open session and returns its new name", async () => {
      const session = await openSession("/repo/runbook.mdx")

      expect(await rename({ name: " prod-deploy " })).toEqual({ name: "prod-deploy" })

      expect(sessions.persistence.currentSession()?.name).toBe("prod-deploy")
      expect((await runtime.runPromise(sessions.store.get(session.id)))?.name).toBe("prod-deploy")
    })

    it("rejects a name that is not allowed with the reason, and keeps the old name", async () => {
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

    it("rejects another session's name", async () => {
      const other = await openSession("/other/runbook.mdx")
      await openSession("/repo/runbook.mdx")

      await expect(rename({ name: other.name })).rejects.toThrow(
        `Another session is already named ${other.name}.`,
      )
    })
  })
})
