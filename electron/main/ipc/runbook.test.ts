import { describe, it, expect, beforeAll, afterEach } from "bun:test"
import { mockElectron } from "../test-utils/mock-electron.ts"

// runbook.ts imports electron's `ipcMain` only to register handlers. Capture
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

const { registerRunbookHandlers } = await import("./runbook.ts")
const runtimeModule = await import("./runtime.ts")
const { setRunbookConfig } = runtimeModule

describe("runbook IPC handlers", () => {
  // runbookConfig is module-global and bun runs every test file in one
  // process: restore it so later files don't inherit this test's config.
  const originalRunbookConfig = runtimeModule.runbookConfig

  beforeAll(() => {
    registerRunbookHandlers()
  })

  afterEach(() => {
    setRunbookConfig(originalRunbookConfig)
  })

  describe("runbook:get without a path", () => {
    it("rejects instead of resolving the empty path against the app's cwd", async () => {
      const localPathBefore = runtimeModule.runbookConfig.localPath

      await expect(handlers.get("runbook:get")!(undefined, { path: "" })).rejects.toThrow(
        "runbook path is required",
      )
      await expect(handlers.get("runbook:get")!(undefined, undefined)).rejects.toThrow(
        "runbook path is required",
      )

      // Nothing was loaded: the config still points where it did.
      expect(runtimeModule.runbookConfig.localPath).toBe(localPathBefore)
    })
  })
})
