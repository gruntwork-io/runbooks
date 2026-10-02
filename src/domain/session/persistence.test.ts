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

  beforeEach(() => {
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

    expect(session.dir).toBe(path.join(dirsRoot, session.id))
    expect(fs.statSync(session.dir).isDirectory()).toBe(true)
    expect(await run(app.manager.getMetadata())).toMatchObject({ workingDir: session.dir })
    expect(app.manager.getRunbookPath()).toBe("/repo/runbook.mdx")
    expect(app.persistence.currentSessionId()).toBe(session.id)
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

    for (const decrypt of [() => undefined, () => "not json", () => '{"set":{"A":1},"unset":[]}']) {
      const app = startApp({ ...reversingCipher, decrypt })
      await app.open()
      expect((await run(app.manager.getExecContext())).env).toEqual({ HOME: "/home/me" })
      app.quit()
    }
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
    // The selected worktree is gone, so the last one still registered stands in.
    expect(second.manager.getActiveWorkTreePath()).toBe(kept)
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
})
