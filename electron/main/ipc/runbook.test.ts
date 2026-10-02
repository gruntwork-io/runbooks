import { describe, it, expect, beforeAll, beforeEach, afterEach, mock, spyOn } from "bun:test"
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
await mock.module("../window.ts", () => ({ getMainWindow: () => fakeWindow }))

const { registerRunbookHandlers } = await import("./runbook.ts")
const { closeRunbook, stopWatcher } = await import("./watch.ts")
const runtimeModule = await import("./runtime.ts")
const { setRunbookConfig, setExecutableRegistry, sessionManager } = runtimeModule

type RunbookGetResult = { path: string; isWatchMode?: boolean }
/** Call runbook:get as the renderer does; `extra` adds fields such as `reload`. */
const getRunbook = (runbookPath: string, extra?: Record<string, unknown>) =>
  handlers.get("runbook:get")!(undefined, {
    path: runbookPath,
    ...extra,
  }) as Promise<RunbookGetResult>

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
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  return true
}

const runbookWith = (command: string) =>
  `# Runbook\n\n<Command id="greet" command="${command}" />\n`

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

/**
 * Hold the `callNumber`th runtime.runPromise call from now on (each of
 * runbook:get's awaits is one) until `release()`, as a slow disk or a slow
 * registry build would. `held` resolves once that call has been made.
 */
function holdRunPromiseCall(callNumber: number) {
  const runtime = runtimeModule.runtime
  const runPromise = runtime.runPromise
  let calls = 0
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached!: () => void
  const held = new Promise<void>((resolve) => {
    reached = resolve
  })
  const spy = spyOn(runtime, "runPromise").mockImplementation(((
    ...args: Parameters<typeof runPromise>
  ) => {
    if (++calls !== callNumber) return runPromise.apply(runtime, args)
    spy.mockRestore()
    reached()
    return released.then(() => runPromise.apply(runtime, args))
  }) as typeof runPromise)
  return { held, release }
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
      for (const [dir, command] of [
        [dirA, "echo a"],
        [dirB, "echo b"],
      ] as const) {
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

    it(
      "in watch mode, reloads on edits to the open runbook, and only the new one's after a switch",
      async () => {
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
      },
      WATCH_TEST_TIMEOUT_MS,
    )

    it(
      "closeRunbook stops reloading the runbook it closed",
      async () => {
        setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })
        const a = await getRunbook(dirA)
        await editUntilReloaded(a.path)

        const closed = sent.length
        closeRunbook()
        expect(sent.slice(closed).map((m) => m.channel)).toEqual(["menu:close-runbook"])

        fs.writeFileSync(a.path, runbookWith("echo a-after-close"))
        // There is no event to wait for when nothing should happen: give a
        // watcher that is still running well over its 300ms debounce.
        await new Promise((resolve) => {
          setTimeout(resolve, 1_000)
        })
        expect(reloadsSince(closed)).toEqual([])
      },
      WATCH_TEST_TIMEOUT_MS,
    )

    describe("a load still running when the runbook is closed", () => {
      // Opening a runbook in a new session awaits resolving its path (call 1),
      // reading it (2), creating the session (3), resetting the warm renders
      // (4) and building its registry (5). The watcher starts before call 5.
      for (const [awaiting, heldCall] of [
        ["resolving its path", 1],
        ["building its registry", 5],
      ] as const) {
        it(
          `starts no watcher and sets no registry after the close (held while ${awaiting})`,
          async () => {
            setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })
            const runbookA = path.join(dirA, "runbook.mdx")

            const hold = holdRunPromiseCall(heldCall)
            const openA = getRunbook(dirA)
            await hold.held
            const closed = sent.length
            closeRunbook()
            hold.release()

            expect<unknown>(await openA).toEqual({ superseded: true })
            expect(runtimeModule.executableRegistry).toBeNull()
            expect(sent.slice(closed).map((m) => m.channel)).toEqual(["menu:close-runbook"])

            // No watcher on A: keep editing it for longer than a new watcher's
            // initial scan plus its 300ms debounce, and nothing reloads.
            for (let edit = 1; edit <= 5; edit++) {
              fs.writeFileSync(runbookA, runbookWith(`echo a-after-close-${edit}`))
              await new Promise((resolve) => {
                setTimeout(resolve, 300)
              })
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 700)
            })
            expect(reloadsSince(closed)).toEqual([])
          },
          WATCH_TEST_TIMEOUT_MS,
        )
      }
    })

    describe("a load that a newer one overtakes", () => {
      // A same-path reload awaits resolving the path (call 1), reading the
      // file (call 2), and building the registry (call 3).
      for (const [awaiting, heldCall] of [
        ["resolving its path", 1],
        ["building its registry", 3],
      ] as const) {
        it(
          `leaves the runbook opened after it in place (held while ${awaiting})`,
          async () => {
            setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })
            const a = await getRunbook(dirA)

            // A watch-mode reload of A that is still running when B is opened
            const hold = holdRunPromiseCall(heldCall)
            const reloadA = getRunbook(dirA, { reload: "watch" })
            await hold.held
            const b = await getRunbook(dirB)
            const registryB = runtimeModule.executableRegistry
            const opened = sent.length
            hold.release()

            // useIpc drops a superseded result; the renderer shows B.
            expect<unknown>(await reloadA).toEqual({ superseded: true })
            expect(runtimeModule.runbookConfig.localPath).toBe(b.path)
            expect(sessionManager.getRunbookPath()).toBe(b.path)
            expect(runtimeModule.executableRegistry).toBe(registryB)
            expect(registryUpdatesSince(opened)).toBe(0)

            // The watcher stays on B.
            fs.writeFileSync(a.path, runbookWith("echo a-after-switch"))
            await editUntilReloaded(b.path, opened)
            expect(new Set(reloadsSince(opened))).toEqual(new Set([b.path]))
          },
          WATCH_TEST_TIMEOUT_MS,
        )
      }

      // Opening A in a new session awaits resolving its path (call 1), reading
      // it (2), creating its session (3), resetting the warm renders (4) and
      // building its registry (5). createSession makes the session as soon as
      // it's called, so the resets' await a newer load can start in is 4.
      for (const [awaiting, heldCall] of [
        ["reading it", 2],
        ["resetting its warm renders", 4],
      ] as const) {
        it(
          `leaves the runbook opened after it in place (open of A held while ${awaiting})`,
          async () => {
            setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })
            const runbookA = path.join(dirA, "runbook.mdx")

            const hold = holdRunPromiseCall(heldCall)
            const openA = getRunbook(dirA)
            await hold.held
            const b = await getRunbook(dirB)
            const registryB = runtimeModule.executableRegistry
            const opened = sent.length
            hold.release()

            expect<unknown>(await openA).toEqual({ superseded: true })
            expect(runtimeModule.runbookConfig.localPath).toBe(b.path)
            expect(sessionManager.getRunbookPath()).toBe(b.path)
            expect(runtimeModule.executableRegistry).toBe(registryB)
            expect(registryUpdatesSince(opened)).toBe(0)

            // The watcher stays on B.
            fs.writeFileSync(runbookA, runbookWith("echo a-after-switch"))
            await editUntilReloaded(b.path, opened)
            expect(new Set(reloadsSince(opened))).toEqual(new Set([b.path]))
          },
          WATCH_TEST_TIMEOUT_MS,
        )
      }
    })

    describe("session working dir", () => {
      const workingDir = async () =>
        (await runtimeModule.runtime.runPromise(sessionManager.getSession())).workingDir

      /** What a block that ran `cd <dir>` leaves in the session. */
      const cdInSession = (from: string, to: string) =>
        runtimeModule.runtime.runPromise(
          sessionManager.applyCapturedEnv({
            before: {},
            after: {},
            startWorkDir: from,
            pwd: to,
            generation: sessionManager.getGeneration(),
          }),
        )

      it("keeps a block's cd across a watch-mode reload, and resets it on a re-open", async () => {
        await getRunbook(dirA)
        const sub = path.join(dirA, "sub")
        fs.mkdirSync(sub)
        await cdInSession(dirA, sub)

        await getRunbook(dirA, { reload: "watch" })
        expect(await workingDir()).toBe(sub)
        // resetSession goes back to where the session started, not the cd.
        await runtimeModule.runtime.runPromise(sessionManager.resetSession())
        expect(await workingDir()).toBe(dirA)

        await cdInSession(dirA, sub)
        await getRunbook(dirA)
        expect(await workingDir()).toBe(dirA)
      })
    })

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

      it("with --disable-live-file-reload, a load that overtakes a switch doesn't keep the previous runbook's registry", async () => {
        setRunbookConfig({ ...originalRunbookConfig, disableLiveFileReload: true })
        await getRunbook(dirB)
        const registryB = runtimeModule.executableRegistry
        const hashB = greetHash()

        // Opening A awaits resolving its path, reading it, creating its session
        // and resetting the warm renders (call 4). Load A again meanwhile: the
        // session already belongs to A, so it keeps the registry it finds.
        const hold = holdRunPromiseCall(4)
        const openA = getRunbook(dirA)
        await hold.held
        const reopenA = await getRunbook(dirA)
        hold.release()

        expect<unknown>(await openA).toEqual({ superseded: true })
        expect(reopenA.path).toBe(path.join(dirA, "runbook.mdx"))
        expect(runtimeModule.executableRegistry).not.toBeNull()
        expect(runtimeModule.executableRegistry).not.toBe(registryB)
        // A's `echo a`, not B's `echo b`
        expect(greetHash()).not.toBe(hashB)
      })
    })
  })
})
