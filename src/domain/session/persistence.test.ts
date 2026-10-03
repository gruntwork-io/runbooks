import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { SessionManager } from "./manager.ts"
import { SessionPersistence, type SessionCipher } from "./persistence.ts"
import { SessionStore } from "./store.ts"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"
import { openSqliteDatabase } from "../../layers/NodeSqlite.ts"

/** Reversible and recognizable, so a test can tell the stored env is not the plaintext. */
const reversingCipher: SessionCipher = {
  encrypt: (plaintext) => new TextEncoder().encode(plaintext).reverse(),
  decrypt: (ciphertext) => new TextDecoder().decode(new Uint8Array(ciphertext).reverse()),
}

const LOCAL = { path: "/repo/runbook.mdx", remoteSource: undefined }

describe("SessionPersistence", () => {
  let root: string
  let dirsRoot: string
  let dbFile: string
  let processEnv: Record<string, string>
  let saveErrors: unknown[]
  /** Picks the words of session names; a test replaces it to force collisions. */
  let random: () => number

  beforeEach(() => {
    random = () => Math.random()
    // realpath: os.tmpdir() is a symlink on macOS, and session dirs are real paths.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-persistence-")))
    dirsRoot = path.join(root, "dirs")
    dbFile = path.join(root, "sessions.db")
    processEnv = { HOME: "/home/me" }
    saveErrors = []
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(Layer.merge(NodeFileSystemLive, makeTestEnvironment(processEnv))),
      ) as Effect.Effect<A, E>,
    )

  /** One run of the app: its own manager and database connection over the same files. */
  function startApp(cipher: SessionCipher = reversingCipher) {
    const store = Effect.runSync(SessionStore.open(openSqliteDatabase(dbFile)))
    const manager = new SessionManager()
    const persistence = new SessionPersistence({
      store,
      manager,
      dirsRoot,
      cipher,
      ephemeralFileEnvVars: ["CREDENTIALS_FILE"],
      random: () => random(),
      onSaveError: (err) => saveErrors.push(err),
    })
    const open = (request: Partial<Parameters<SessionPersistence["open"]>[0]> = {}) =>
      run(
        persistence.open({
          runbook: LOCAL,
          launchDir: undefined,
          sessionId: undefined,
          startNew: false,
          ...request,
        }),
      )
    return { store, manager, persistence, open, quit: () => Effect.runSync(store.close()) }
  }

  it("creates a session directory and starts the session in it", async () => {
    const app = startApp()

    const session = await app.open()

    // A version 7 UUID, which is also the name of the session's directory.
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(session.dir).toBe(path.join(dirsRoot, session.id))
    expect(fs.statSync(session.dir).isDirectory()).toBe(true)
    expect(await run(app.manager.getMetadata())).toMatchObject({ workingDir: session.dir })
    expect(app.manager.getRunbookPath()).toBe("/repo/runbook.mdx")
    expect(app.persistence.currentSession()).toEqual(session)
  })

  describe("session names", () => {
    it("names a session adjective-noun and keeps the name when it is resumed", async () => {
      const first = startApp()
      const session = await first.open()
      expect(session.name).toMatch(/^[a-z]+-[a-z]+$/)
      first.quit()

      const second = startApp()

      expect((await second.open()).name).toBe(session.name)
    })

    it("gives a new session another name than the one it replaces", async () => {
      const app = startApp()
      const first = await app.open()

      const second = await app.open({ startNew: true })

      expect(second.name).toMatch(/^[a-z]+-[a-z]+$/)
      expect(second.name).not.toBe(first.name)
    })

    it("numbers a name when every random pick is taken, and ends on the session id", async () => {
      // Always the first adjective and the first noun.
      random = () => 0
      const app = startApp()

      const names: string[] = []
      for (let i = 0; i < 20; i++) names.push((await app.open({ startNew: true })).name)
      const last = await app.open({ startNew: true })

      expect(names).toEqual([
        "agile-acorn",
        ...Array.from({ length: 19 }, (_, i) => `agile-acorn-${i + 2}`),
      ])
      // Every numbered name is taken too: the session's own id can't be.
      expect(last.name).toBe(`agile-acorn-${last.id}`)
    })
  })

  describe("renameCurrent", () => {
    /** The failure a rename ends in, as the IPC handler's caller sees it. */
    const renameFailure = async (app: ReturnType<typeof startApp>, name: string) => {
      const exit = await run(Effect.either(app.persistence.renameCurrent(name)))
      return exit._tag === "Left" ? exit.left : undefined
    }

    it("renames the open session, and the name is still there after a restart", async () => {
      const first = startApp()
      const session = await first.open()

      expect(await run(first.persistence.renameCurrent("prod-deploy"))).toBe("prod-deploy")

      expect(first.persistence.currentSession()).toEqual({ ...session, name: "prod-deploy" })
      first.quit()
      const second = startApp()
      expect(await second.open()).toEqual({ ...session, name: "prod-deploy" })
    })

    it("drops the whitespace around the name", async () => {
      const app = startApp()
      await app.open()

      expect(await run(app.persistence.renameCurrent("  prod-deploy\n"))).toBe("prod-deploy")
    })

    it("does nothing when the session already has the name", async () => {
      const app = startApp()
      const session = await app.open()

      expect(await run(app.persistence.renameCurrent(session.name))).toBe(session.name)
    })

    it.each([
      ["", "Enter a name."],
      ["   ", "Enter a name."],
      ["a".repeat(64), "A session name can be at most 63 characters."],
      ["Prod Deploy", /^Use lowercase letters, digits and hyphens/],
      ["../../etc", /^Use lowercase letters, digits and hyphens/],
    ])("refuses %j and keeps the name the session had", async (name, message) => {
      const app = startApp()
      const session = await app.open()

      const failure = await renameFailure(app, name)

      expect(failure).toMatchObject({ _tag: "SessionNameError" })
      expect((failure as { message: string }).message).toMatch(message)
      expect(app.persistence.currentSession()?.name).toBe(session.name)
      expect(Effect.runSync(app.store.get(session.id))?.name).toBe(session.name)
    })

    it("refuses a name another session has, and says so", async () => {
      const app = startApp()
      const first = await app.open()
      const second = await app.open({ startNew: true })

      const failure = await renameFailure(app, first.name)

      expect(failure).toMatchObject({
        _tag: "SessionNameError",
        message: `Another session is already named ${first.name}.`,
      })
      expect(app.persistence.currentSession()?.name).toBe(second.name)
    })

    it("lets a session take a name that another session gave up", async () => {
      const app = startApp()
      const first = await app.open()
      await run(app.persistence.renameCurrent("prod-deploy"))
      await app.open({ startNew: true })

      expect(await run(app.persistence.renameCurrent(first.name))).toBe(first.name)
    })

    it("fails when no session is open", async () => {
      const app = startApp()

      expect(await renameFailure(app, "prod-deploy")).toMatchObject({
        _tag: "SessionNotFoundError",
      })
    })
  })

  it("resumes the runbook's session in a later run, with what its scripts left behind", async () => {
    const first = startApp()
    const session = await first.open()
    const repo = path.join(session.dir, "repo")
    fs.mkdirSync(repo)
    const start = await run(first.manager.getExecContext())
    await run(
      first.manager.applyCapturedEnv({
        before: start.env,
        after: { ...start.env, EXPORTED: "1" },
        startWorkDir: start.workDir,
        pwd: repo,
        generation: start.generation,
      }),
    )
    first.manager.registerWorkTreePath(repo)
    first.manager.setActiveWorkTreePath(repo)
    first.quit()

    processEnv = { HOME: "/home/me", PATH: "/new/bin" }
    const second = startApp()
    const resumed = await second.open()

    expect(resumed).toEqual(session)
    expect(await run(second.manager.getExecContext())).toMatchObject({
      env: { HOME: "/home/me", PATH: "/new/bin", EXPORTED: "1" },
      workDir: repo,
    })
    expect(second.manager.getActiveWorkTreePath()).toBe(repo)
    expect((await run(second.manager.getMetadata())).executionCount).toBe(1)
    expect(saveErrors).toEqual([])
  })

  describe("saveVcsBindings", () => {
    it("binds a resumed session's git credentials to the hosts they were bound to", async () => {
      const first = startApp()
      await first.open()
      first.persistence.saveVcsBindings({ github: { host: "ghe.example.com", source: "oauth" } })
      expect(first.persistence.currentSession()?.vcsBindings).toEqual({
        github: { host: "ghe.example.com", source: "oauth" },
      })
      first.quit()

      const second = startApp()
      const resumed = await second.open()

      expect(resumed.vcsBindings).toEqual({ github: { host: "ghe.example.com", source: "oauth" } })
      expect(saveErrors).toEqual([])
    })

    it("starts a new session without bindings", async () => {
      const app = startApp()
      await app.open()
      app.persistence.saveVcsBindings({ gitlab: { host: "gitlab.com" } })

      const fresh = await app.open({ startNew: true })

      expect(fresh.vcsBindings).toEqual({})
    })

    it("saves nothing before a session is open", () => {
      const app = startApp()

      app.persistence.saveVcsBindings({ gitlab: { host: "gitlab.com" } })

      expect(app.persistence.currentSession()).toBeUndefined()
      expect(saveErrors).toEqual([])
    })

    it("reports a failed save and keeps the bindings for the open session", async () => {
      const app = startApp()
      await app.open()
      app.quit()

      app.persistence.saveVcsBindings({ gitlab: { host: "gitlab.com" } })

      expect(saveErrors).toHaveLength(1)
      expect(String(saveErrors[0])).toContain("save a session's git host bindings")
      expect(app.persistence.currentSession()?.vcsBindings).toEqual({
        gitlab: { host: "gitlab.com" },
      })
    })
  })

  it("stores the env encrypted", async () => {
    const app = startApp()
    const session = await app.open()

    await run(app.manager.appendToEnv({ GITHUB_TOKEN: "ghp_secret" }))

    const stored = Effect.runSync(app.store.get(session.id))?.env
    const text = new TextDecoder().decode(stored)
    expect(text).not.toContain("ghp_secret")
    expect(reversingCipher.decrypt(stored!)).toContain("ghp_secret")
  })

  it("resumes without the env when it could not be encrypted", async () => {
    const noEncryption: SessionCipher = { encrypt: () => undefined, decrypt: () => undefined }
    const first = startApp(noEncryption)
    const session = await first.open()
    await run(first.manager.appendToEnv({ GITHUB_TOKEN: "ghp_secret" }))
    expect(Effect.runSync(first.store.get(session.id))?.env).toBeUndefined()
    first.quit()

    const second = startApp(noEncryption)
    await second.open()

    expect((await run(second.manager.getExecContext())).env).toEqual({ HOME: "/home/me" })
  })

  it("resumes without the env when the saved one can't be decrypted or parsed", async () => {
    const first = startApp()
    await first.open()
    await run(first.manager.appendToEnv({ GITHUB_TOKEN: "ghp_secret" }))
    first.quit()

    const notEnvChanges = [
      "null",
      "[]",
      '"set"',
      '{"unset":[]}',
      '{"set":null,"unset":[]}',
      '{"set":"A=1","unset":[]}',
      '{"set":{"A":1},"unset":[]}',
      '{"set":{"A":"1","B":2},"unset":[]}',
      '{"set":{}}',
      '{"set":{},"unset":"A"}',
      // One bad name spoils the whole list, the good one included.
      '{"set":{},"unset":["HOME",1]}',
    ]
    for (const decrypt of [
      () => undefined,
      () => "not json",
      ...notEnvChanges.map((json) => () => json),
    ]) {
      const app = startApp({ ...reversingCipher, decrypt })
      await app.open()
      expect((await run(app.manager.getExecContext())).env).toEqual({ HOME: "/home/me" })
      app.quit()
    }
  })

  it("resumes a saved env that unsets a variable the app was launched with", async () => {
    const first = startApp()
    await first.open()
    await run(first.manager.removeFromEnv(["HOME"]))
    first.quit()

    const app = startApp({
      ...reversingCipher,
      decrypt: () => '{"set":{"A":"1"},"unset":["HOME"]}',
    })
    await app.open()

    expect((await run(app.manager.getExecContext())).env).toEqual({ A: "1" })
  })

  it("drops an env var naming a credentials file that was deleted since", async () => {
    const first = startApp()
    const session = await first.open()
    const kept = path.join(session.dir, "kept.json")
    fs.writeFileSync(kept, "{}")
    await run(
      first.manager.appendToEnv({
        CREDENTIALS_FILE: path.join(root, "deleted-at-quit.json"),
        OTHER_FILE: path.join(root, "also-missing.json"),
      }),
    )
    first.quit()

    const second = startApp()
    await second.open()
    const { env } = await run(second.manager.getExecContext())
    expect(env.CREDENTIALS_FILE).toBeUndefined()
    // Only the listed vars are checked.
    expect(env.OTHER_FILE).toBe(path.join(root, "also-missing.json"))

    await run(second.manager.appendToEnv({ CREDENTIALS_FILE: kept }))
    second.quit()
    const third = startApp()
    await third.open()
    expect((await run(third.manager.getExecContext())).env.CREDENTIALS_FILE).toBe(kept)
  })

  it("falls back to the session directory and drops worktrees that were deleted since", async () => {
    const first = startApp()
    const session = await first.open()
    const gone = path.join(session.dir, "gone")
    const kept = path.join(session.dir, "kept")
    fs.mkdirSync(gone)
    fs.mkdirSync(kept)
    const start = await run(first.manager.getExecContext())
    await run(
      first.manager.applyCapturedEnv({
        before: start.env,
        after: start.env,
        startWorkDir: start.workDir,
        pwd: gone,
        generation: start.generation,
      }),
    )
    first.manager.registerWorkTreePath(kept)
    first.manager.registerWorkTreePath(gone)
    first.manager.setActiveWorkTreePath(gone)
    first.quit()
    fs.rmSync(gone, { recursive: true })

    const second = startApp()
    await second.open()

    expect((await run(second.manager.getMetadata())).workingDir).toBe(session.dir)
    expect([...(await run(second.manager.getSession())).registeredWorkTreePaths]).toEqual([kept])
    // The selected worktree is gone, so the last one still registered stands in.
    expect(second.manager.getActiveWorkTreePath()).toBe(kept)
  })

  it("saves a new session with nothing but its runbook, directory and times", async () => {
    const app = startApp()

    const session = await app.open({ launchDir: "/home/me/project" })

    const saved = Effect.runSync(app.store.get(session.id))!
    expect(saved).toEqual({
      id: session.id,
      name: session.name,
      path: LOCAL.path,
      remoteSource: undefined,
      dir: session.dir,
      workingDir: session.dir,
      launchDir: "/home/me/project",
      env: undefined,
      worktrees: [],
      activeWorktree: "",
      executionCount: 0,
      createdAt: saved.createdAt,
      lastLaunchedAt: saved.createdAt,
      lastActivityAt: saved.createdAt,
      vcsBindings: {},
    })
    expect(Date.parse(saved.createdAt)).not.toBeNaN()
  })

  it("resumes the runbook's latest session when the named one does not exist", async () => {
    const app = startApp()
    const latest = await app.open()

    const resumed = await app.open({ sessionId: "01900000-0000-7000-8000-000000000000" })

    expect(resumed).toEqual(latest)
  })

  it("recreates a session directory that was deleted", async () => {
    const first = startApp()
    const session = await first.open()
    first.quit()
    fs.rmSync(session.dir, { recursive: true })

    const second = startApp()
    const resumed = await second.open()

    expect(resumed).toEqual(session)
    expect(fs.statSync(session.dir).isDirectory()).toBe(true)
  })

  it("gives each runbook its own session", async () => {
    const app = startApp()
    const a = await app.open()
    await run(app.manager.appendToEnv({ FROM_A: "1" }))

    const b = await app.open({ runbook: { path: "/other/runbook.mdx", remoteSource: undefined } })

    expect(b.id).not.toBe(a.id)
    expect((await run(app.manager.getExecContext())).env.FROM_A).toBeUndefined()
    // Switching back resumes the first runbook's session.
    expect(await app.open()).toEqual(a)
    expect((await run(app.manager.getExecContext())).env.FROM_A).toBe("1")
  })

  it("resumes a remote runbook's session although its clone moved", async () => {
    const url = "https://github.com/acme/runbooks//deploy"
    const first = startApp()
    const session = await first.open({
      runbook: { path: "/tmp/clone-1/runbook.mdx", remoteSource: url },
    })
    first.quit()

    const second = startApp()
    const resumed = await second.open({
      runbook: { path: "/tmp/clone-2/runbook.mdx", remoteSource: url },
    })

    expect(resumed).toEqual(session)
    expect(second.manager.getRunbookPath()).toBe("/tmp/clone-2/runbook.mdx")
    expect(Effect.runSync(second.store.get(session.id))?.path).toBe("/tmp/clone-2/runbook.mdx")
  })

  describe("startNew", () => {
    it("starts an empty session and leaves the previous one on disk", async () => {
      const app = startApp()
      const previous = await app.open({ launchDir: "/home/me/project" })
      await run(app.manager.appendToEnv({ FROM_PREVIOUS: "1" }))

      const fresh = await app.open({ startNew: true })

      expect(fresh.id).not.toBe(previous.id)
      expect((await run(app.manager.getExecContext())).env).toEqual({ HOME: "/home/me" })
      expect(fs.statSync(previous.dir).isDirectory()).toBe(true)
      expect(reversingCipher.decrypt(Effect.runSync(app.store.get(previous.id))!.env!)).toContain(
        "FROM_PREVIOUS",
      )
    })

    it("is the session the runbook and its launch directory resume next", async () => {
      const first = startApp()
      await first.open({ launchDir: "/home/me/project" })
      const fresh = await first.open({ startNew: true })
      first.quit()

      const second = startApp()

      expect(Effect.runSync(second.persistence.findForLaunch("/home/me/project"))?.id).toBe(
        fresh.id,
      )
      expect((await second.open()).id).toBe(fresh.id)
    })
  })

  describe("findForLaunch", () => {
    it("finds the session last launched from a directory, or the latest of all without one", async () => {
      const app = startApp()
      const a = await app.open({ launchDir: "/a" })
      const b = await app.open({
        runbook: { path: "/b/runbook.mdx", remoteSource: undefined },
        launchDir: "/b",
      })

      expect(Effect.runSync(app.persistence.findForLaunch("/a"))?.id).toBe(a.id)
      expect(Effect.runSync(app.persistence.findForLaunch("/b"))?.id).toBe(b.id)
      expect(Effect.runSync(app.persistence.findForLaunch("/c"))).toBeUndefined()
      expect(Effect.runSync(app.persistence.findForLaunch(undefined))?.id).toBe(b.id)
    })

    it("keeps a session's launch directory when it is resumed without one", async () => {
      const first = startApp()
      const session = await first.open({ launchDir: "/a" })
      first.quit()

      const second = startApp()
      await second.open()

      expect(Effect.runSync(second.persistence.findForLaunch("/a"))?.id).toBe(session.id)
    })
  })

  describe("sessionId", () => {
    it("resumes the named session instead of the runbook's latest", async () => {
      const app = startApp()
      const older = await app.open({ launchDir: "/a" })
      const newer = await app.open({ startNew: true, launchDir: "/b" })

      expect((await app.open()).id).toBe(newer.id)
      expect((await app.open({ sessionId: older.id })).id).toBe(older.id)
    })
  })

  describe("recordLaunch", () => {
    it("moves the open session to the directory it was launched from again", async () => {
      const app = startApp()
      const session = await app.open({ launchDir: "/a" })

      await run(app.persistence.recordLaunch("/repo/runbook.mdx", "/b"))

      expect(Effect.runSync(app.persistence.findForLaunch("/b"))?.id).toBe(session.id)
      expect(Effect.runSync(app.persistence.findForLaunch("/a"))).toBeUndefined()
    })

    it("does nothing while no session is open", async () => {
      const app = startApp()

      await run(app.persistence.recordLaunch("/repo/runbook.mdx", "/b"))

      expect(Effect.runSync(app.persistence.findForLaunch("/b"))).toBeUndefined()
    })
  })

  describe("listSessions", () => {
    it("lists the saved sessions, marking the open one and those whose runbook file is gone", async () => {
      const runbook = path.join(root, "runbook.mdx")
      fs.writeFileSync(runbook, "# Runbook\n")
      const app = startApp()
      const here = await app.open({ runbook: { path: runbook, remoteSource: undefined } })
      const gone = await app.open({ runbook: LOCAL })
      const remote = await app.open({
        runbook: {
          path: "/tmp/deleted-clone/runbook.mdx",
          remoteSource: "https://github.com/acme/r",
        },
      })

      const listed = await run(app.persistence.listSessions())

      const flags = Object.fromEntries(
        listed.map((s) => [s.id, { isCurrent: s.isCurrent, runbookMissing: s.runbookMissing }]),
      )
      expect(flags).toEqual({
        [here.id]: { isCurrent: false, runbookMissing: false },
        [gone.id]: { isCurrent: false, runbookMissing: true },
        [remote.id]: { isCurrent: true, runbookMissing: false },
      })
      expect(listed.find((s) => s.id === here.id)).toMatchObject({
        name: here.name,
        path: runbook,
        remoteSource: undefined,
        dir: here.dir,
      })
    })

    it("is empty before any session was saved", async () => {
      expect(await run(startApp().persistence.listSessions())).toEqual([])
    })
  })

  describe("deleteSession", () => {
    it("deletes another session with its history and its directory", async () => {
      const app = startApp()
      const old = await app.open()
      fs.writeFileSync(path.join(old.dir, "generated.tf"), "x")
      await run(app.persistence.recordEvent(old.id, { blockId: "b", kind: "inputs", payload: {} }))
      const current = await app.open({ startNew: true })

      await run(app.persistence.deleteSession(old.id))

      expect(Effect.runSync(app.persistence.findSession(old.id))).toBeUndefined()
      expect(fs.existsSync(old.dir)).toBe(false)
      expect(fs.existsSync(current.dir)).toBe(true)
      expect((await run(app.persistence.listSessions())).map((s) => s.id)).toEqual([current.id])
    })

    it("refuses to delete the open session, and says why", async () => {
      const app = startApp()
      const open = await app.open()

      const result = await run(Effect.either(app.persistence.deleteSession(open.id)))

      expect(result).toMatchObject({
        _tag: "Left",
        left: {
          _tag: "SessionDeleteError",
          message: "This session is open. Switch to another session before deleting it.",
        },
      })
      expect(fs.existsSync(open.dir)).toBe(true)
      expect(Effect.runSync(app.persistence.findSession(open.id))).toBeDefined()
    })

    it("leaves a directory that is not the session's own one under the sessions root", async () => {
      const app = startApp()
      const old = await app.open()
      await app.open({ startNew: true })
      const elsewhere = path.join(root, "not-a-session-dir")
      fs.mkdirSync(elsewhere)
      const db = openSqliteDatabase(dbFile)
      db.prepare("UPDATE sessions SET dir = ? WHERE id = ?").run(elsewhere, old.id)
      db.close()

      await run(app.persistence.deleteSession(old.id))

      expect(Effect.runSync(app.persistence.findSession(old.id))).toBeUndefined()
      expect(fs.existsSync(elsewhere)).toBe(true)
    })

    it("does nothing for a session that does not exist", async () => {
      const app = startApp()
      const open = await app.open()

      await run(app.persistence.deleteSession("01900000-0000-7000-8000-000000000000"))

      expect((await run(app.persistence.listSessions())).map((s) => s.id)).toEqual([open.id])
    })
  })

  it("reports a cipher that throws and keeps the session running", async () => {
    const app = startApp({
      ...reversingCipher,
      encrypt: () => {
        throw new Error("keychain access denied")
      },
    })
    await app.open()

    await run(app.manager.appendToEnv({ TOKEN: "t" }))

    expect(saveErrors).toHaveLength(1)
    expect(String(saveErrors[0])).toContain("keychain access denied")
    expect((await run(app.manager.getExecContext())).env.TOKEN).toBe("t")
  })

  it("reports a failed save and keeps the session running", async () => {
    const app = startApp()
    await app.open()
    app.quit()

    await run(app.manager.appendToEnv({ AFTER_CLOSE: "1" }))

    expect(saveErrors).toHaveLength(1)
    expect((await run(app.manager.getExecContext())).env.AFTER_CLOSE).toBe("1")
  })

  it("stops saving a replaced session's late writes into the new one", async () => {
    const app = startApp()
    const a = await app.open()
    const generationA = app.manager.getGeneration()
    const b = await app.open({ runbook: { path: "/other/runbook.mdx", remoteSource: undefined } })

    await run(app.manager.appendToEnv({ LATE: "1" }, generationA))

    expect(Effect.runSync(app.store.get(a.id))?.env).toBeUndefined()
    expect(Effect.runSync(app.store.get(b.id))?.env).toBeUndefined()
  })

  describe("history", () => {
    type App = ReturnType<typeof startApp>

    const FORM = { values: { region: "us-east-1" }, submitted: true }
    const RUN = { status: "success", exitCode: 0, logs: [{ line: "done", timestamp: "t" }] }

    const record = (app: App, sessionId: string, blockId: string, kind: string, payload: unknown) =>
      run(app.persistence.recordEvent(sessionId, { blockId, kind, payload }))

    /** Every event in the database as `block kind`, oldest first, read over a connection of its own. */
    function storedEvents(): Array<{ event: string; payload: Uint8Array }> {
      const db = openSqliteDatabase(dbFile)
      const rows = db
        .prepare("SELECT block_id, kind, payload FROM session_events ORDER BY seq")
        .all() as Array<{ block_id: string; kind: string; payload: Uint8Array }>
      db.close()
      return rows.map((row) => ({ event: `${row.block_id} ${row.kind}`, payload: row.payload }))
    }

    it("gives each block back what it was left as, in a later run of the app", async () => {
      const first = startApp()
      const session = await first.open()
      await record(first, session.id, "config", "inputs", FORM)
      await record(first, session.id, "deploy", "run", { status: "running" })
      await record(first, session.id, "deploy", "run", RUN)
      first.quit()

      const second = startApp()
      await second.open()

      expect(await run(second.persistence.blockStates())).toEqual([
        { blockId: "config", kind: "inputs", payload: FORM },
        { blockId: "deploy", kind: "run", payload: RUN },
      ])
      expect(saveErrors).toEqual([])
    })

    it("keeps a form as it was left and every run, in order", async () => {
      const app = startApp()
      const session = await app.open()

      for (const region of ["u", "us", "us-east-1"]) {
        await record(app, session.id, "config", "inputs", { values: { region }, submitted: false })
      }
      await record(app, session.id, "deploy", "run", { status: "running" })
      await record(app, session.id, "deploy", "run", { ...RUN, status: "fail", exitCode: 1 })
      await record(app, session.id, "config", "inputs", FORM)
      await record(app, session.id, "deploy", "run", { status: "running" })
      await record(app, session.id, "deploy", "run", RUN)

      const stored = storedEvents()
      expect(stored.map((row) => row.event)).toEqual([
        "config inputs",
        "deploy run",
        "deploy run",
        "config inputs",
        "deploy run",
        "deploy run",
      ])
      // The three edits before the first run are one event: the last of them.
      expect(JSON.parse(reversingCipher.decrypt(stored[0]!.payload)!)).toEqual({
        values: { region: "us-east-1" },
        submitted: false,
      })
    })

    it("stores the payload encrypted", async () => {
      const app = startApp()
      const session = await app.open()

      await record(app, session.id, "login", "inputs", {
        values: { password: "hunter2" },
        submitted: true,
      })

      const [stored] = storedEvents()
      expect(new TextDecoder().decode(stored!.payload)).not.toContain("hunter2")
      expect(reversingCipher.decrypt(stored!.payload)).toContain("hunter2")
    })

    it("saves nothing where the payload can't be encrypted", async () => {
      const app = startApp({ encrypt: () => undefined, decrypt: () => undefined })
      const session = await app.open()

      await record(app, session.id, "config", "inputs", FORM)

      expect(storedEvents()).toEqual([])
      expect(await run(app.persistence.blockStates())).toEqual([])
      expect(saveErrors).toEqual([])
    })

    it("drops an event of a session that is no longer the current one", async () => {
      const app = startApp()
      const replaced = await app.open()
      await app.open({ startNew: true })

      await record(app, replaced.id, "config", "inputs", FORM)

      expect(storedEvents()).toEqual([])
    })

    it("starts a block over when its state can't be decrypted or parsed", async () => {
      const first = startApp()
      const session = await first.open()
      await record(first, session.id, "config", "inputs", FORM)
      first.quit()

      for (const decrypt of [() => undefined, () => "not json"]) {
        const app = startApp({ ...reversingCipher, decrypt })
        await app.open()
        expect(await run(app.persistence.blockStates())).toEqual([])
        app.quit()
      }
    })

    it("leaves out an event of a kind this version does not know", async () => {
      const app = startApp()
      const session = await app.open()
      await record(app, session.id, "config", "inputs", FORM)
      Effect.runSync(
        app.store.appendEvent(
          {
            sessionId: session.id,
            at: "2030-01-01T00:00:00.000Z",
            blockId: "config",
            kind: "from-a-later-version",
            payload: reversingCipher.encrypt("{}")!,
          },
          { replacePrevious: false },
        ),
      )

      expect(await run(app.persistence.blockStates())).toEqual([
        { blockId: "config", kind: "inputs", payload: FORM },
      ])
    })

    it("fails for an event that is not one, and saves nothing", async () => {
      const app = startApp()
      const session = await app.open()

      await expect(record(app, session.id, "config", "outputs", {})).rejects.toThrow(
        /must be one of inputs, run, render, clone, pull-request, auth/,
      )
      await expect(record(app, session.id, "", "inputs", FORM)).rejects.toThrow(
        /the id of its block/,
      )

      expect(storedEvents()).toEqual([])
    })

    it("reports a failed save, and a cipher that throws, without failing the block", async () => {
      const failing = startApp({
        ...reversingCipher,
        encrypt: () => {
          throw new Error("keychain access denied")
        },
      })
      const session = await failing.open()

      await record(failing, session.id, "config", "inputs", FORM)

      expect(saveErrors).toHaveLength(1)
      expect(String(saveErrors[0])).toContain("keychain access denied")
      failing.quit()

      const closed = startApp()
      const reopened = await closed.open()
      closed.quit()

      await record(closed, reopened.id, "config", "inputs", FORM)

      expect(saveErrors).toHaveLength(2)
      expect(String(saveErrors[1])).toContain("failed to save a session event")
    })

    it("has no states before a session is open", async () => {
      const app = startApp()

      expect(await run(app.persistence.blockStates())).toEqual([])
    })

    it("drops an event while no session is open", async () => {
      const app = startApp()

      await run(
        app.persistence.recordEvent("s1", { blockId: "inputs", kind: "inputs", payload: {} }),
      )

      expect(saveErrors).toEqual([])
    })
  })
})
