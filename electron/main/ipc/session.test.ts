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
})
