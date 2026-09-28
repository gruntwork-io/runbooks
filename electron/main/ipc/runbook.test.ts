import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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

// The main window runbook:get and the watch-mode watcher send to: records
// every message main sends the renderer.
const sent: Array<{ channel: string; payload: unknown }> = []
const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload?: unknown) => {
      sent.push({ channel, payload })
    },
  },
}
mock.module("../window.ts", () => ({ getMainWindow: () => fakeWindow }))

const { registerRunbookHandlers } = await import("./runbook.ts")
const { closeRunbook, stopWatcher } = await import("./watch.ts")
const runtimeModule = await import("./runtime.ts")
const { setRunbookConfig, setExecutableRegistry, sessionManager } = runtimeModule

type RunbookGetResult = { path: string; isWatchMode?: boolean }
const getRunbook = (runbookPath: string) =>
  handlers.get("runbook:get")!(undefined, { path: runbookPath }) as Promise<RunbookGetResult>

/** The runbook paths of the watch:file-change events sent since `from`. */
const reloadsSince = (from: number) =>
  sent
    .slice(from)
    .filter((m) => m.channel === "watch:file-change")
    .map((m) => (m.payload as { path: string }).path)

const registryUpdatesSince = (from: number) =>
  sent.slice(from).filter((m) => m.channel === "registry:updated").length

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return true
}

const runbookWith = (command: string) => `# Runbook\n\n<Command id="greet" command="${command}" />\n`

/** Real chokidar watchers: allow for a slow file system on top of the debounce. */
const WATCH_TEST_TIMEOUT_MS = 20_000

/**
 * Edit `runbookFile` until main reports a reload of it. A watcher that has
 * only just started can miss a write made before chokidar finished its
 * initial scan, so write again until one is reported rather than sleeping.
 */
async function editUntilReloaded(runbookFile: string, from = sent.length): Promise<void> {
  const deadline = Date.now() + WATCH_TEST_TIMEOUT_MS / 2
  for (let edit = 1; !reloadsSince(from).includes(runbookFile); edit++) {
    if (Date.now() > deadline) throw new Error(`no reload was sent for ${runbookFile}`)
    fs.writeFileSync(runbookFile, runbookWith(`echo edit-${edit}`))
    await waitUntil(() => reloadsSince(from).includes(runbookFile), 1_000)
  }
}

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

  describe("runbook:get loading runbooks", () => {
    let tmp: string
    let dirA: string
    let dirB: string

    beforeEach(() => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbook-ipc-")))
      dirA = path.join(tmp, "a")
      dirB = path.join(tmp, "b")
      for (const [dir, command] of [[dirA, "echo a"], [dirB, "echo b"]]) {
        fs.mkdirSync(dir)
        fs.writeFileSync(path.join(dir, "runbook.mdx"), runbookWith(command))
      }
    })

    afterEach(async () => {
      await stopWatcher()
      sessionManager.deleteSession()
      setExecutableRegistry(null)
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it("keeps --watch from the launch config instead of resetting it on each load", async () => {
      // index.ts sets the launch flags with setRunbookConfig; the renderer's
      // runbook:get never sends watchMode.
      setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })

      const result = await getRunbook(dirA)

      expect(result.isWatchMode).toBe(true)
      expect(runtimeModule.runbookConfig).toMatchObject({
        localPath: path.join(dirA, "runbook.mdx"),
        isWatchMode: true,
      })
    })

    it("in watch mode, reloads on edits to the open runbook, and only the new one's after a switch", async () => {
      setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })
      const a = await getRunbook(dirA)
      await editUntilReloaded(a.path)

      const b = await getRunbook(dirB)
      const switched = sent.length
      fs.writeFileSync(a.path, runbookWith("echo a-after-switch"))
      // B's reload comes at least one debounce after A's edit, so a watcher
      // still running on A would have reported that edit first.
      await editUntilReloaded(b.path, switched)

      expect(new Set(reloadsSince(switched))).toEqual(new Set([b.path]))
    }, WATCH_TEST_TIMEOUT_MS)

    it("closeRunbook stops reloading the runbook it closed", async () => {
      setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })
      const a = await getRunbook(dirA)
      await editUntilReloaded(a.path)

      const closed = sent.length
      closeRunbook()
      expect(sent.slice(closed).map((m) => m.channel)).toEqual(["menu:close-runbook"])

      fs.writeFileSync(a.path, runbookWith("echo a-after-close"))
      // There is no event to wait for when nothing should happen: give a
      // watcher that is still running well over its 300ms debounce.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(reloadsSince(closed)).toEqual([])
    }, WATCH_TEST_TIMEOUT_MS)

    describe("executable registry", () => {
      const greetHash = () =>
        Object.values(runtimeModule.executableRegistry!.getAllExecutables()).find(
          (e) => e.componentId === "greet",
        )!.contentHash

      it("rebuilds on every load of the same runbook and tells the renderer", async () => {
        await getRunbook(dirA)
        const first = runtimeModule.executableRegistry
        const hashBefore = greetHash()

        fs.writeFileSync(path.join(dirA, "runbook.mdx"), runbookWith("echo a-edited"))
        const from = sent.length
        await getRunbook(dirA)

        expect(runtimeModule.executableRegistry).not.toBe(first)
        expect(greetHash()).not.toBe(hashBefore)
        expect(registryUpdatesSince(from)).toBe(1)
      })

      it("with --disable-live-file-reload, keeps the registry for the same runbook and rebuilds for A -> B -> A", async () => {
        setRunbookConfig({ ...originalRunbookConfig, disableLiveFileReload: true })
        await getRunbook(dirA)
        const frozen = runtimeModule.executableRegistry
        const frozenHash = greetHash()

        // A reload of the same runbook after its command changed on disk (what
        // a watch-mode reload or re-opening the file does) keeps executing
        // what was approved at open, and the renderer's registry stays put.
        fs.writeFileSync(path.join(dirA, "runbook.mdx"), runbookWith("echo a-edited"))
        let from = sent.length
        await getRunbook(dirA)
        expect(runtimeModule.executableRegistry).toBe(frozen)
        expect(greetHash()).toBe(frozenHash)
        expect(registryUpdatesSince(from)).toBe(0)

        from = sent.length
        await getRunbook(dirB)
        const registryB = runtimeModule.executableRegistry
        expect(registryB).not.toBe(frozen)
        expect(registryUpdatesSince(from)).toBe(1)

        // Back on A: the old frozen registry was dropped with the switch, so
        // A's registry is rebuilt from what is on disk now.
        from = sent.length
        await getRunbook(dirA)
        expect(runtimeModule.executableRegistry).not.toBe(frozen)
        expect(runtimeModule.executableRegistry).not.toBe(registryB)
        expect(greetHash()).not.toBe(frozenHash)
        expect(registryUpdatesSince(from)).toBe(1)
      })
    })
  })
})
