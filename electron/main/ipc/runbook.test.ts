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

// The main window runbook:get, runbook:reload-script and the file watchers
// send to: records every message main sends the renderer.
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

const {
  registerRunbookHandlers,
  expectLaunch,
  isSessionOpen,
  markRunbookClosed,
  resetToNewSession,
} = await import("./runbook.ts")
const { closeRunbook, stopWatchers } = await import("./watch.ts")
const runtimeModule = await import("./runtime.ts")
const { setRunbookConfig, setExecutableRegistry, sessionManager } = runtimeModule
const { installTestSessionPersistence } = await import("../test-utils/session-persistence.ts")
type TestSessionPersistence = ReturnType<typeof installTestSessionPersistence>

type RunbookGetResult = {
  path: string
  isWatchMode?: boolean
  sessionId: string
  sessionName: string
  sessionDir: string
  blockStates: unknown[]
}
/** Call runbook:get as the renderer does; `extra` adds fields such as `remoteSource`. */
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
    let sessions: TestSessionPersistence

    beforeEach(() => {
      sessions = installTestSessionPersistence()
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
      await stopWatchers()
      markRunbookClosed()
      sessionManager.deleteSession()
      setExecutableRegistry(null)
      sessions.cleanup()
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
      // file (call 2), building the registry (call 3), and reading the
      // session's history (call 4).
      for (const [awaiting, heldCall] of [
        ["resolving its path", 1],
        ["building its registry", 3],
        ["reading the session's history", 4],
      ] as const) {
        it(
          `leaves the runbook opened after it in place (held while ${awaiting})`,
          async () => {
            setRunbookConfig({ ...originalRunbookConfig, isWatchMode: true })
            const a = await getRunbook(dirA)

            // A reload of A that is still running when B is opened
            const hold = holdRunPromiseCall(heldCall)
            const reloadA = getRunbook(dirA)
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

      it("ends on the newer runbook's session when the older load is still starting its own", async () => {
        // Call 3 of opening A starts its session.
        const hold = holdRunPromiseCall(3)
        const openA = getRunbook(dirA)
        await hold.held
        const openB = getRunbook(dirB)
        // B can't finish before A's session has started, so there is nothing
        // to await: give it time to get as far as it can.
        await new Promise((resolve) => {
          setTimeout(resolve, 200)
        })
        hold.release()

        expect<unknown>(await openA).toEqual({ superseded: true })
        const b = await openB
        expect(sessionManager.getRunbookPath()).toBe(b.path)
        expect(sessions.persistence.currentSession()?.id).toBe(b.sessionId)
        expect(runtimeModule.runbookConfig.localPath).toBe(b.path)
      })

      it("starts no session for a load overtaken while it waits for its turn", async () => {
        // Call 3 of opening B starts its session, in B's turn.
        const hold = holdRunPromiseCall(3)
        const openB = getRunbook(dirB)
        await hold.held
        // A reads its file and queues for a turn behind B's.
        const openA = getRunbook(dirA)
        await new Promise((resolve) => {
          setTimeout(resolve, 200)
        })
        // B again, overtaking A before A's turn comes.
        const reopenB = getRunbook(dirB)
        hold.release()

        expect<unknown>(await openA).toEqual({ superseded: true })
        expect<unknown>(await openB).toEqual({ superseded: true })
        const b = await reopenB
        expect(sessions.persistence.currentSession()?.id).toBe(b.sessionId)
        const runbookA = { path: path.join(dirA, "runbook.mdx"), remoteSource: undefined }
        expect(
          await runtimeModule.runtime.runPromise(sessions.store.latestForRunbook(runbookA)),
        ).toBeUndefined()
      })
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

      it("starts in the session's own directory, not the runbook's folder", async () => {
        const result = await getRunbook(dirA)

        const sessionDir = path.join(sessions.dirsRoot, result.sessionId)
        expect(await workingDir()).toBe(sessionDir)
        expect(fs.statSync(sessionDir).isDirectory()).toBe(true)
        expect(result.sessionDir).toBe(sessionDir)
      })

      it("keeps a block's cd when the runbook is loaded again, as after a restart", async () => {
        const { sessionId } = await getRunbook(dirA)
        const sessionDir = path.join(sessions.dirsRoot, sessionId)
        const sub = path.join(sessionDir, "sub")
        fs.mkdirSync(sub)
        await cdInSession(sessionDir, sub)

        // A watch-mode reload, or a re-open after a close
        const reloaded = await getRunbook(dirA)
        expect(await workingDir()).toBe(sub)
        // The session's directory is where it started, wherever a block has moved to.
        expect(reloaded.sessionDir).toBe(sessionDir)
        // resetSession goes back to where the session started, not the cd.
        await runtimeModule.runtime.runPromise(sessionManager.resetSession())
        expect(await workingDir()).toBe(sessionDir)
      })
    })

    describe("saved sessions", () => {
      const sessionEnv = async () =>
        (await runtimeModule.runtime.runPromise(sessionManager.getExecContext())).env

      /** What quitting and starting the app again leaves: the database, and no live session. */
      const restartApp = () => {
        markRunbookClosed()
        sessionManager.deleteSession()
      }

      it("resumes a runbook's session after a restart, env and working dir included", async () => {
        const first = await getRunbook(dirA)
        const sub = path.join(sessions.dirsRoot, first.sessionId, "sub")
        fs.mkdirSync(sub)
        await runtimeModule.runtime.runPromise(sessionManager.appendToEnv({ FROM_BLOCK: "1" }))
        const start = await runtimeModule.runtime.runPromise(sessionManager.getExecContext())
        await runtimeModule.runtime.runPromise(
          sessionManager.applyCapturedEnv({
            before: start.env,
            after: start.env,
            startWorkDir: start.workDir,
            pwd: sub,
            generation: start.generation,
          }),
        )
        restartApp()

        const second = await getRunbook(dirA)

        expect(second.sessionId).toBe(first.sessionId)
        expect(first.sessionName).toMatch(/^[a-z]+-[a-z]+$/)
        expect(second.sessionName).toBe(first.sessionName)
        expect((await sessionEnv()).FROM_BLOCK).toBe("1")
        expect(
          (await runtimeModule.runtime.runPromise(sessionManager.getSession())).workingDir,
        ).toBe(sub)
      })

      it("keeps one session per runbook when switching between them", async () => {
        const a = await getRunbook(dirA)
        await runtimeModule.runtime.runPromise(sessionManager.appendToEnv({ FROM_A: "1" }))

        const b = await getRunbook(dirB)
        expect(b.sessionId).not.toBe(a.sessionId)
        expect((await sessionEnv()).FROM_A).toBeUndefined()

        expect((await getRunbook(dirA)).sessionId).toBe(a.sessionId)
        expect((await sessionEnv()).FROM_A).toBe("1")
      })

      it("registers a resumed session's tokens for log redaction", async () => {
        const { redactSecrets } = await import("../../../src/domain/vcs/redact.ts")
        const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        await getRunbook(dirA)
        // Straight into the session, as a script's `export` would: nothing
        // registered this value in this run.
        await runtimeModule.runtime.runPromise(sessionManager.appendToEnv({ GITLAB_TOKEN: token }))
        expect(redactSecrets(`token ${token}`)).toContain(token)
        restartApp()

        await getRunbook(dirA)

        expect(redactSecrets(`token ${token}`)).not.toContain(token)
      })

      it("binds a resumed session's git credentials to the hosts they were bound to", async () => {
        const { vcsSessionMeta, saveVcsSessionMeta } = runtimeModule
        await getRunbook(dirA)
        vcsSessionMeta.set("github", { host: "ghe.example.com", source: "oauth" })
        saveVcsSessionMeta()

        await getRunbook(dirB)
        expect(vcsSessionMeta.size).toBe(0)
        restartApp()

        await getRunbook(dirA)
        expect(Object.fromEntries(vcsSessionMeta)).toEqual({
          github: { host: "ghe.example.com", source: "oauth" },
        })
      })

      it("returns what the session's history says each block was left as", async () => {
        const form = { values: { region: "us-east-1" }, submitted: true }
        const record = (sessionId: string, payload: unknown) =>
          runtimeModule.runtime.runPromise(
            sessions.persistence.recordEvent(sessionId, {
              blockId: "config",
              kind: "inputs",
              payload,
            }),
          )
        const first = await getRunbook(dirA)
        expect(first.blockStates).toEqual([])
        await record(first.sessionId, form)

        // Opening the runbook again, as after a close, reads the history as it is now.
        const saved = [{ blockId: "config", kind: "inputs", payload: form }]
        expect((await getRunbook(dirA)).blockStates).toEqual(saved)
        restartApp()
        expect((await getRunbook(dirA)).blockStates).toEqual(saved)

        // Another runbook has a session, and so a history, of its own.
        expect((await getRunbook(dirB)).blockStates).toEqual([])

        // A reset session starts with none, and the next load resumes that one.
        await getRunbook(dirA)
        resetToNewSession()
        const reset = await getRunbook(dirA)
        expect(reset.blockStates).toEqual([])
        await record(reset.sessionId, { values: { region: "eu-west-1" }, submitted: false })
        restartApp()
        expect((await getRunbook(dirA)).blockStates).toEqual([
          {
            blockId: "config",
            kind: "inputs",
            payload: { values: { region: "eu-west-1" }, submitted: false },
          },
        ])
      })

      it("opens the runbook with its blocks as new when the history can't be read", async () => {
        const { sessionId } = await getRunbook(dirA)
        const { Effect } = await import("effect")
        const { SessionStoreError } = await import("../../../src/errors/index.ts")
        const read = spyOn(sessions.store, "latestEvents").mockReturnValue(
          Effect.fail(new SessionStoreError({ message: "disk I/O error" })),
        )

        try {
          const result = await getRunbook(dirA)

          expect(result.sessionId).toBe(sessionId)
          expect(result.blockStates).toEqual([])
        } finally {
          read.mockRestore()
        }
      })

      describe("resetToNewSession", () => {
        it("reloads the open runbook under a new, empty session", async () => {
          const first = await getRunbook(dirA, { remoteSource: "https://example.com/acme/a" })
          await runtimeModule.runtime.runPromise(sessionManager.appendToEnv({ FROM_BLOCK: "1" }))

          const from = sent.length
          resetToNewSession()
          // The renderer answers file:open-runbook by loading that runbook.
          const reopen = sent.slice(from).find((m) => m.channel === "file:open-runbook")!
          expect(reopen.payload).toEqual({
            path: first.path,
            remoteSource: "https://example.com/acme/a",
          })
          const second = await getRunbook(first.path, {
            remoteSource: "https://example.com/acme/a",
          })

          expect(second.sessionId).not.toBe(first.sessionId)
          expect(second.sessionName).not.toBe(first.sessionName)
          expect((await sessionEnv()).FROM_BLOCK).toBeUndefined()
          expect(
            (await runtimeModule.runtime.runPromise(sessionManager.getSession())).workingDir,
          ).toBe(path.join(sessions.dirsRoot, second.sessionId))
          // One request starts one session: the next load of the runbook keeps it.
          expect((await getRunbook(first.path)).sessionId).toBe(second.sessionId)
        })

        it("is the session the runbook resumes after a restart", async () => {
          const first = await getRunbook(dirA)
          resetToNewSession()
          const second = await getRunbook(first.path)
          restartApp()

          expect((await getRunbook(dirA)).sessionId).toBe(second.sessionId)
        })

        it("does nothing while no runbook is open", async () => {
          await getRunbook(dirA)
          closeRunbook()

          const from = sent.length
          resetToNewSession()

          expect(sent.slice(from)).toEqual([])
        })
      })

      describe("expectLaunch", () => {
        const launchDirOf = (id: string) =>
          runtimeModule.runtime.runPromise(sessions.store.get(id)).then((s) => s?.launchDir)

        it("records the directory a runbook was launched from", async () => {
          expectLaunch({ source: dirA, launchDir: "/home/me/project", sessionId: undefined })

          const a = await getRunbook(dirA)

          expect(await launchDirOf(a.sessionId)).toBe("/home/me/project")
        })

        it("applies only to the runbook that was launched", async () => {
          expectLaunch({ source: dirA, launchDir: "/home/me/project", sessionId: undefined })

          const b = await getRunbook(dirB)
          expect(await launchDirOf(b.sessionId)).toBeUndefined()

          const a = await getRunbook(dirA)
          expect(await launchDirOf(a.sessionId)).toBe("/home/me/project")
        })

        it("matches a remote runbook by its URL", async () => {
          const url = "https://github.com/acme/runbooks//a"
          expectLaunch({ source: url, launchDir: "/home/me/project", sessionId: undefined })

          const a = await getRunbook(dirA, { remoteSource: url })

          expect(await launchDirOf(a.sessionId)).toBe("/home/me/project")
        })

        it("resumes the named session instead of the runbook's latest", async () => {
          const older = await getRunbook(dirA)
          resetToNewSession()
          const newer = await getRunbook(older.path)
          expect(newer.sessionId).not.toBe(older.sessionId)

          // `runbooks` run in the directory the older session was launched from.
          expectLaunch({ source: older.path, launchDir: "/older", sessionId: older.sessionId })
          const resumed = await getRunbook(older.path)

          expect(resumed.sessionId).toBe(older.sessionId)
          expect(await launchDirOf(older.sessionId)).toBe("/older")
        })

        it("moves the open runbook's session to the directory it was launched from again", async () => {
          expectLaunch({ source: dirA, launchDir: "/first", sessionId: undefined })
          const a = await getRunbook(dirA)
          await runtimeModule.runtime.runPromise(sessionManager.appendToEnv({ KEPT: "1" }))

          expectLaunch({ source: dirA, launchDir: "/second", sessionId: undefined })
          const again = await getRunbook(dirA)

          expect(again.sessionId).toBe(a.sessionId)
          expect((await sessionEnv()).KEPT).toBe("1")
          expect(await launchDirOf(a.sessionId)).toBe("/second")
        })

        it("keeps the open session as it is when the launch names it", async () => {
          const a = await getRunbook(dirA)
          const manifest = { templateId: "t", outputDir: "/out", files: [], timestamp: 0 }
          runtimeModule.manifestStore.set("t", manifest as never)

          expectLaunch({ source: dirA, launchDir: "/again", sessionId: a.sessionId })
          const again = await getRunbook(dirA)

          expect(again.sessionId).toBe(a.sessionId)
          // Nothing a session switch resets was reset.
          expect(runtimeModule.manifestStore.get("t")).toBe(manifest as never)
          expect(await launchDirOf(a.sessionId)).toBe("/again")
          runtimeModule.manifestStore.clear()
        })

        it("applies to one load: the next load of the runbook keeps the session it has", async () => {
          const older = await getRunbook(dirA)
          resetToNewSession()
          const newer = await getRunbook(older.path)
          expectLaunch({ source: older.path, launchDir: "/older", sessionId: older.sessionId })
          expect((await getRunbook(older.path)).sessionId).toBe(older.sessionId)

          resetToNewSession()
          const newest = await getRunbook(older.path)
          // A watch-mode reload, after the launch was used up.
          const reloaded = await getRunbook(older.path)

          expect(newest.sessionId).not.toBe(newer.sessionId)
          expect(reloaded.sessionId).toBe(newest.sessionId)
        })
      })

      describe("isSessionOpen", () => {
        it("is true for the loaded runbook's session until the runbook is closed", async () => {
          const a = await getRunbook(dirA)
          expect(isSessionOpen(a.sessionId)).toBe(true)
          expect(isSessionOpen("another-session")).toBe(false)

          closeRunbook()

          expect(isSessionOpen(a.sessionId)).toBe(false)
        })
      })
    })

    describe("a script file that changes after the runbook loaded", () => {
      type ScriptChange = {
        registeredContent: string
        diskContent: string
        diskContentHash: string
      }
      let runbookFile: string
      let scriptFile: string

      beforeEach(() => {
        runbookFile = path.join(dirA, "runbook.mdx")
        scriptFile = path.join(dirA, "scripts", "deploy.sh")
        fs.mkdirSync(path.dirname(scriptFile))
        fs.writeFileSync(scriptFile, "echo v1\n")
        fs.writeFileSync(path.join(dirA, "scripts", "verify.sh"), "echo verify\n")
        fs.writeFileSync(
          runbookFile,
          '# Runbook\n\n<Command id="deploy" path="scripts/deploy.sh" />\n\n<Check id="verify" path="scripts/verify.sh" />\n',
        )
      })

      const scriptChange = async () =>
        (
          (await handlers.get("runbook:script-change")!(undefined, { componentId: "deploy" })) as {
            change: ScriptChange | null
          }
        ).change

      const reloadScript = (contentHash: string) =>
        handlers.get("runbook:reload-script")!(undefined, { componentId: "deploy", contentHash })

      /** The script Run executes for the block: the registry's copy. */
      const registeredScript = () => {
        const registry = runtimeModule.executableRegistry!
        const entry = Object.values(registry.getAllExecutables()).find(
          (e) => e.componentId === "deploy",
        )!
        return registry.getExecutableSync(entry.id)!.content
      }

      /** The block IDs of each watch:script-change event sent since `from`. */
      const scriptChangesSince = (from: number) =>
        sent
          .slice(from)
          .filter((m) => m.channel === "watch:script-change")
          .map((m) => (m.payload as { componentIds: string[] }).componentIds)

      it("reports the change and keeps executing the loaded version until the script is reloaded", async () => {
        await getRunbook(dirA)
        expect(await scriptChange()).toBeNull()

        fs.writeFileSync(scriptFile, "echo v2\n")
        const change = await scriptChange()

        expect(change).toMatchObject({ registeredContent: "echo v1\n", diskContent: "echo v2\n" })
        expect(registeredScript()).toBe("echo v1\n")

        const from = sent.length
        expect(await reloadScript(change!.diskContentHash)).toEqual({ ok: true })

        expect(registeredScript()).toBe("echo v2\n")
        expect(registryUpdatesSince(from)).toBe(1)
        expect(await scriptChange()).toBeNull()
      })

      it("rejects a reload of a version the user did not review, and keeps the loaded one", async () => {
        await getRunbook(dirA)
        fs.writeFileSync(scriptFile, "echo v2\n")
        const reviewed = await scriptChange()
        // The file changes again between the review and the click.
        fs.writeFileSync(scriptFile, "echo v3\n")

        const from = sent.length
        await expect(reloadScript(reviewed!.diskContentHash)).rejects.toThrow(
          "changed again after you reviewed it",
        )

        expect(registeredScript()).toBe("echo v1\n")
        expect(registryUpdatesSince(from)).toBe(0)
        expect(await scriptChange()).toMatchObject({ diskContent: "echo v3\n" })
      })

      it("with --disable-live-file-reload, a reloaded script stays registered across a reload of the runbook", async () => {
        setRunbookConfig({ ...originalRunbookConfig, disableLiveFileReload: true })
        await getRunbook(dirA)
        fs.writeFileSync(scriptFile, "echo v2\n")
        await reloadScript((await scriptChange())!.diskContentHash)

        // A later edit is not picked up by reloading the runbook: the registry
        // is frozen apart from the script the user reloaded.
        fs.writeFileSync(scriptFile, "echo v3\n")
        await getRunbook(dirA, { reload: "watch" })

        expect(registeredScript()).toBe("echo v2\n")
      })

      it(
        "tells the renderer which block's script file was written, without --watch",
        async () => {
          await getRunbook(dirA)
          const from = sent.length

          // A watcher that has only just started can miss a write made before
          // chokidar finished its initial scan, so write until one is reported.
          const deadline = Date.now() + WATCH_TEST_TIMEOUT_MS / 2
          for (let edit = 1; scriptChangesSince(from).length === 0; edit++) {
            if (Date.now() > deadline) throw new Error("no script change was sent")
            fs.writeFileSync(scriptFile, `echo edit-${edit}\n`)
            await waitUntil(() => scriptChangesSince(from).length > 0, 1_000)
          }

          // Only the block whose script was written is named, never "verify".
          expect(new Set(scriptChangesSince(from).flat())).toEqual(new Set(["deploy"]))
          // Nothing but the notice: the runbook isn't reloaded and the registry isn't rebuilt.
          expect(new Set(sent.slice(from).map((m) => m.channel))).toEqual(
            new Set(["watch:script-change"]),
          )
          expect(registeredScript()).toBe("echo v1\n")
        },
        WATCH_TEST_TIMEOUT_MS,
      )

      it(
        "closeRunbook stops reporting changes to the closed runbook's scripts",
        async () => {
          await getRunbook(dirA)
          const closed = sent.length
          closeRunbook()

          for (let edit = 1; edit <= 5; edit++) {
            fs.writeFileSync(scriptFile, `echo after-close-${edit}\n`)
            await new Promise((resolve) => {
              setTimeout(resolve, 300)
            })
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 700)
          })
          expect(scriptChangesSince(closed)).toEqual([])
        },
        WATCH_TEST_TIMEOUT_MS,
      )
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

      it("with --disable-live-file-reload, keeps the registry when the runbook starts a new session", async () => {
        setRunbookConfig({ ...originalRunbookConfig, disableLiveFileReload: true })
        const first = await getRunbook(dirA)
        const frozen = runtimeModule.executableRegistry
        fs.writeFileSync(path.join(dirA, "runbook.mdx"), runbookWith("echo a-edited"))

        resetToNewSession()
        const from = sent.length
        const second = await getRunbook(first.path)

        expect(second.sessionId).not.toBe(first.sessionId)
        expect(runtimeModule.executableRegistry).toBe(frozen)
        expect(registryUpdatesSince(from)).toBe(0)
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
