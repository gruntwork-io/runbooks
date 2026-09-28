import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { mockElectron } from "../test-utils/mock-electron.ts"

// workspace.ts imports electron's `ipcMain` only to register handlers. Capture
// them so the test can call a handler the way the renderer's invoke would.
type Handler = (event: unknown, params: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    },
  },
})

const { registerWorkspaceHandlers } = await import("./workspace.ts")
const runtimeModule = await import("./runtime.ts")
const { runtime, sessionManager, setRunbookConfig } = runtimeModule

describe("workspace IPC handlers", () => {
  let tmpDir = ""

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-workspace-ipc-"))
    registerWorkspaceHandlers()
    await runtime.runPromise(sessionManager.createSession(tmpDir))
  })

  afterAll(() => {
    sessionManager.deleteSession()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("workspace:dirs", () => {
    it("returns the subdirectories wrapped in { dirs }, matching the channel contract", async () => {
      fs.mkdirSync(nodePath.join(tmpDir, "beta"))
      fs.mkdirSync(nodePath.join(tmpDir, "alpha"))
      fs.mkdirSync(nodePath.join(tmpDir, ".hidden"))
      fs.writeFileSync(nodePath.join(tmpDir, "file.txt"), "not a directory")

      const handler = handlers.get("workspace:dirs")!
      const result = await handler(undefined, { worktreePath: tmpDir })

      // The renderer reads `result.dirs`; a bare array here leaves every
      // DirPicker dropdown empty.
      expect(result).toEqual({ dirs: ["alpha", "beta"] })
    })

    it("lists a relative rootDir against the runbook directory, not the process cwd", async () => {
      // runbookConfig is module-global and bun runs every test file in one
      // process: restore it so later files don't inherit this runbook.
      const originalRunbookConfig = runtimeModule.runbookConfig
      const runbookDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-workspace-runbook-"))
      try {
        fs.mkdirSync(nodePath.join(runbookDir, "dev"))
        fs.mkdirSync(nodePath.join(runbookDir, "prod"))
        setRunbookConfig({ ...originalRunbookConfig, localPath: nodePath.join(runbookDir, "runbook.mdx") })

        // <DirPicker rootDir="."> sends the relative path as written.
        const handler = handlers.get("workspace:dirs")!
        const result = await handler(undefined, { worktreePath: "." })

        expect(result).toEqual({ dirs: ["dev", "prod"] })
      } finally {
        setRunbookConfig(originalRunbookConfig)
        fs.rmSync(runbookDir, { recursive: true, force: true })
      }
    })
  })
})
