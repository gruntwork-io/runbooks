import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { mockElectron } from "./test-utils/mock-electron.ts"

// The OS credential store, as Electron's safeStorage exposes it. A test sets
// what it reports and what its calls do.
const keychain = {
  available: true,
  backend: "gnome_libsecret",
  encrypt: (plaintext: string): Buffer => Buffer.from(`enc:${plaintext}`),
  decrypt: (ciphertext: Buffer): string => ciphertext.toString().replace(/^enc:/, ""),
}

mockElectron({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    getSelectedStorageBackend: () => keychain.backend,
    encryptString: (plaintext: string) => keychain.encrypt(plaintext),
    decryptString: (ciphertext: Buffer) => keychain.decrypt(ciphertext),
  },
})

const { openSessionStorage } = await import("./session-storage.ts")
const { runtime, sessionManager } = await import("./ipc/runtime.ts")
const { SessionStore } = await import("../../src/domain/session/store.ts")
const { openSqliteDatabase } = await import("../../src/layers/NodeSqlite.ts")

describe("openSessionStorage", () => {
  let userData: string
  let storage: ReturnType<typeof openSessionStorage> | undefined
  const platform = process.platform
  const consoleSpies: Array<{ mockRestore: () => void }> = []
  let warnings: string[]

  beforeEach(() => {
    // realpath: os.tmpdir() is a symlink on macOS, and session dirs are real paths.
    userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-userdata-")))
    keychain.available = true
    keychain.backend = "gnome_libsecret"
    keychain.encrypt = (plaintext) => Buffer.from(`enc:${plaintext}`)
    keychain.decrypt = (ciphertext) => ciphertext.toString().replace(/^enc:/, "")
    warnings = []
    consoleSpies.push(
      spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "))
      }),
      spyOn(console, "error").mockImplementation(() => {}),
    )
  })

  afterEach(() => {
    storage?.close()
    storage = undefined
    sessionManager.deleteSession()
    Object.defineProperty(process, "platform", { value: platform })
    for (const spy of consoleSpies.splice(0)) spy.mockRestore()
    fs.rmSync(userData, { recursive: true, force: true })
  })

  const sessionsRoot = () => path.join(userData, "v0", "sessions")
  const dbFile = () => path.join(sessionsRoot(), "db", "sessions.db")

  /** Open storage and a session for a runbook in it, as runbook:get does. */
  async function openSession() {
    storage = openSessionStorage(userData)
    return runtime.runPromise(
      storage.persistence.open({
        runbook: { path: "/repo/runbook.mdx", remoteSource: undefined },
        launchDir: undefined,
        sessionId: undefined,
        startNew: false,
      }),
    )
  }

  /** What the database file has for session `id`, read after the storage closed. */
  function savedSession(id: string) {
    const store = Effect.runSync(SessionStore.open(openSqliteDatabase(dbFile())))
    try {
      return Effect.runSync(store.get(id))
    } finally {
      Effect.runSync(store.close())
    }
  }

  /** Give the open session an env var, then close the storage. */
  async function saveEnvAndClose(id: string) {
    await runtime.runPromise(sessionManager.appendToEnv({ TOKEN: "s3cret" }))
    storage!.close()
    storage = undefined
    return savedSession(id)
  }

  it("creates the database and the session directories, readable only by the user", async () => {
    const session = await openSession()

    expect(session.name).toMatch(/^[a-z]+-[a-z]+$/)
    expect(session.name).not.toContain("undefined")
    expect(fs.existsSync(dbFile())).toBe(true)
    expect(session.dir).toBe(path.join(sessionsRoot(), "dirs", session.id))
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(dbFile())).mode & 0o777).toBe(0o700)
      expect(fs.statSync(path.join(sessionsRoot(), "dirs")).mode & 0o777).toBe(0o700)
    }
  })

  it("stores the env encrypted by the OS credential store, and resumes it", async () => {
    const session = await openSession()

    const saved = await saveEnvAndClose(session.id)

    const stored = new TextDecoder().decode(saved?.env)
    expect(stored.startsWith("enc:")).toBe(true)
    expect(stored).toContain("s3cret")

    sessionManager.deleteSession()
    const resumed = await openSession()
    expect(resumed.id).toBe(session.id)
    const env = (await runtime.runPromise(sessionManager.getExecContext())).env
    expect(env.TOKEN).toBe("s3cret")
  })

  it("saves no env, and warns once, when the OS has no credential store", async () => {
    keychain.available = false
    const session = await openSession()
    await runtime.runPromise(sessionManager.appendToEnv({ OTHER: "1" }))

    const saved = await saveEnvAndClose(session.id)

    expect(saved?.env).toBeUndefined()
    expect(saved?.name).toBe(session.name)
    expect(warnings.filter((w) => w.includes("No OS credential store"))).toHaveLength(1)
  })

  it("resumes without the env when the credential store has gone away since", async () => {
    const session = await openSession()
    await saveEnvAndClose(session.id)
    keychain.available = false

    sessionManager.deleteSession()
    await openSession()

    const env = (await runtime.runPromise(sessionManager.getExecContext())).env
    expect(env.TOKEN).toBeUndefined()
  })

  it("saves no env on Linux when safeStorage would use its hardcoded key", async () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    keychain.backend = "basic_text"
    const session = await openSession()

    expect((await saveEnvAndClose(session.id))?.env).toBeUndefined()
  })

  it("saves the env on Linux with a secret service", async () => {
    Object.defineProperty(process, "platform", { value: "linux" })
    keychain.backend = "gnome_libsecret"
    const session = await openSession()

    expect((await saveEnvAndClose(session.id))?.env).toBeDefined()
  })

  it("trusts any backend name outside Linux, where basic_text does not exist", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    keychain.backend = "basic_text"
    const session = await openSession()

    expect((await saveEnvAndClose(session.id))?.env).toBeDefined()
  })

  it("saves the rest of the session when encrypting fails", async () => {
    keychain.encrypt = () => {
      throw new Error("User denied Keychain access")
    }
    const session = await openSession()

    const saved = await saveEnvAndClose(session.id)

    expect(saved?.env).toBeUndefined()
    expect(saved?.name).toBe(session.name)
    expect(warnings.some((w) => w.includes("Can't encrypt"))).toBe(true)
  })

  it("resumes without the env when decrypting fails", async () => {
    const session = await openSession()
    await saveEnvAndClose(session.id)
    keychain.decrypt = () => {
      throw new Error("Keychain locked")
    }

    sessionManager.deleteSession()
    const resumed = await openSession()

    expect(resumed.id).toBe(session.id)
    const env = (await runtime.runPromise(sessionManager.getExecContext())).env
    expect(env.TOKEN).toBeUndefined()
    expect(warnings.some((w) => w.includes("Can't decrypt"))).toBe(true)
  })

  it("keeps sessions in memory for the run when the database can't be opened", async () => {
    // A file where the database's directory should be.
    fs.mkdirSync(sessionsRoot(), { recursive: true })
    fs.writeFileSync(path.join(sessionsRoot(), "db"), "not a directory")

    const session = await openSession()

    expect(storage!.persistence.currentSession()?.id).toBe(session.id)
    expect(fs.statSync(path.join(sessionsRoot(), "db")).isFile()).toBe(true)
    storage!.close()
    storage = undefined
    expect(fs.existsSync(dbFile())).toBe(false)
  })
})
