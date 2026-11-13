import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { X509Certificate } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { CA_BUNDLE_ENV_VARS } from "../../src/domain/tls/customCa.ts"
import { makeTestEnvironment } from "../../src/test-utils/TestEnvironment.ts"
import { clearCustomCa, getCustomCaStatus, initCustomCa, setCustomCaFile } from "./custom-ca.ts"
import { sessionManager } from "./ipc/runtime.ts"
import { initSystemTrust, registerExtraCaPems } from "./system-trust.ts"
import type { TrustTls } from "./system-trust.ts"

const FIXTURES = path.join(import.meta.dir, "../../test/fixtures/tls")
const CA_FILE = path.join(FIXTURES, "ca.pem")
const KEY_FILE = path.join(FIXTURES, "ca-key.pem")
// How Node encodes the fixture CA, which is how it is installed.
const CA = new X509Certificate(fs.readFileSync(CA_FILE)).toString()
// A second real certificate, standing in for one the user's env already trusted.
const CORP = fs.readFileSync(path.join(FIXTURES, "localhost-cert.pem"), "utf8")

const pem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`
const BUNDLED = pem("BUNDLED")
const SYSTEM = pem("SYSTEM")
const EXTRA = pem("EXTRA")

/** A fake node:tls whose installs are recorded (see system-trust.test.ts). */
const makeFakeTls = () => {
  let current = [BUNDLED]
  const installs: string[][] = []
  const tls: TrustTls = {
    getCACertificates: (type) => [...(type === "default" ? current : [SYSTEM])],
    setDefaultCACertificates: (certs) => {
      current = [...certs]
      installs.push([...certs])
    },
  }
  return { tls, installs, lastInstall: () => installs[installs.length - 1]! }
}

let fake: ReturnType<typeof makeFakeTls>
let dataDir: string
let savedEnv: Record<string, string | undefined>

const bundlePath = () => path.join(dataDir, "custom-ca-bundle.pem")
const settingPath = () => path.join(dataDir, "custom-ca.json")
const bundleOf = (pems: string[]) => `${pems.map((p) => p.trim()).join("\n")}\n`
/** Make writing the bundle fail: a file can't be renamed over a folder. */
const blockBundle = () => {
  fs.rmSync(bundlePath(), { force: true })
  fs.mkdirSync(bundlePath())
}
const leftoverTempFiles = () => fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))
const caEnv = () => Object.fromEntries(CA_BUNDLE_ENV_VARS.map((name) => [name, process.env[name]]))
const sessionEnv = async () => (await Effect.runPromise(sessionManager.getExecContext())).env

/** What a launch does: install system trust, then load the saved custom CA. */
function launch(): void {
  fake = makeFakeTls()
  initSystemTrust({ tls: fake.tls })
  initCustomCa({ dataDir })
}

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => {})
  spyOn(console, "warn").mockImplementation(() => {})
  spyOn(console, "error").mockImplementation(() => {})
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runbooks-custom-ca-"))
  // Start every test from an env without the vars, whatever the machine's has.
  savedEnv = caEnv()
  for (const name of CA_BUNDLE_ENV_VARS) delete process.env[name]
})

afterEach(() => {
  // Forget this test's custom CA while its dataDir still exists: the module's
  // state (and its trust listener) outlives the test.
  clearCustomCa()
  mock.restore()
  sessionManager.deleteSession()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe("without a custom CA", () => {
  it("trusts nothing more, sets no env vars and writes no bundle", () => {
    launch()

    expect(fake.installs).toEqual([[BUNDLED, SYSTEM]])
    expect(getCustomCaStatus()).toEqual({ certificates: [] })
    expect(Object.values(caEnv()).every((value) => value === undefined)).toBe(true)
    expect(fs.existsSync(bundlePath())).toBe(false)
  })

  it("takes the custom CA out of a bundle left over from an earlier run, for its scripts", () => {
    fs.writeFileSync(bundlePath(), bundleOf([BUNDLED, SYSTEM, CA]))
    launch()
    expect(fs.readFileSync(bundlePath(), "utf8")).toBe(bundleOf([BUNDLED, SYSTEM]))
  })

  it("doesn't hand on env vars naming the bundle, inherited from a script of an earlier run", async () => {
    fs.writeFileSync(bundlePath(), bundleOf([BUNDLED, SYSTEM, CA]))
    process.env.SSL_CERT_FILE = bundlePath()
    process.env.GIT_SSL_CAINFO = bundlePath()
    process.env.CURL_CA_BUNDLE = "/etc/corp.pem"
    launch()

    expect(process.env.SSL_CERT_FILE).toBeUndefined()
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined()
    expect(process.env.CURL_CA_BUNDLE).toBe("/etc/corp.pem")
    await Effect.runPromise(
      sessionManager.createSession("/work").pipe(Effect.provide(makeTestEnvironment({}))),
    )
    expect((await sessionEnv()).SSL_CERT_FILE).toBeUndefined()
  })
})

describe("setCustomCaFile", () => {
  it("trusts the file's certificates in main, after everything else", () => {
    launch()

    const { status, rejected } = setCustomCaFile(CA_FILE)

    expect(rejected).toBeUndefined()
    expect(status.path).toBe(CA_FILE)
    expect(status.certificates.map((c) => c.subject)).toEqual(["Runbooks TLS Test Fixture CA"])
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, CA])
  })

  it("hands everything main trusts to spawned processes, through a bundle file", () => {
    launch()

    setCustomCaFile(CA_FILE)

    const bundle = fs.readFileSync(bundlePath(), "utf8")
    expect(bundle).toBe(`${[BUNDLED, SYSTEM, CA].map((p) => p.trim()).join("\n")}\n`)
    for (const value of Object.values(caEnv())) expect(value).toBe(bundlePath())
  })

  it("gives the open session the env vars too, out of its saved changes", async () => {
    launch()
    await Effect.runPromise(
      sessionManager.createSession("/work").pipe(Effect.provide(makeTestEnvironment({}))),
    )

    setCustomCaFile(CA_FILE)

    expect((await sessionEnv()).GIT_SSL_CAINFO).toBe(bundlePath())
    await Effect.runPromise(sessionManager.resetSession())
    expect((await sessionEnv()).GIT_SSL_CAINFO).toBe(bundlePath())
  })

  it("is saved, so the next launch trusts it again", () => {
    launch()
    setCustomCaFile(CA_FILE)
    for (const name of CA_BUNDLE_ENV_VARS) delete process.env[name]

    launch()

    expect(getCustomCaStatus().path).toBe(CA_FILE)
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, CA])
    expect(process.env.SSL_CERT_FILE).toBe(bundlePath())
  })

  it("changes nothing for a file with no certificate, and says why", () => {
    launch()

    const { status, rejected } = setCustomCaFile(KEY_FILE)

    expect(rejected).toBe("The file has no certificates. Choose the CA's certificate, not a key.")
    expect(status).toEqual({ certificates: [] })
    expect(fake.installs).toHaveLength(1)
    expect(fs.existsSync(settingPath())).toBe(false)
    expect(process.env.SSL_CERT_FILE).toBeUndefined()
  })

  it("keeps the current custom CA when the new file is rejected", () => {
    launch()
    setCustomCaFile(CA_FILE)

    expect(setCustomCaFile(path.join(dataDir, "missing.pem")).rejected).toBe(
      "The file isn't there anymore.",
    )
    expect(getCustomCaStatus().path).toBe(CA_FILE)
    expect(fake.lastInstall()).toContain(CA)
  })

  it("carries on the certificates of the files the env vars named, which the bundle replaces", () => {
    const corpFile = path.join(dataDir, "corp.pem")
    fs.writeFileSync(corpFile, CORP)
    process.env.REQUESTS_CA_BUNDLE = corpFile
    launch()

    setCustomCaFile(CA_FILE)

    expect(fs.readFileSync(bundlePath(), "utf8")).toContain(CORP.trim())
    expect(process.env.REQUESTS_CA_BUNDLE).toBe(bundlePath())
  })

  it("keeps the bundle up to date as other trust changes", () => {
    launch()
    setCustomCaFile(CA_FILE)

    registerExtraCaPems([EXTRA])

    expect(fs.readFileSync(bundlePath(), "utf8")).toContain(EXTRA)
  })

  it("trusts nothing and saves nothing when the bundle for spawned processes can't be written", () => {
    launch()
    blockBundle()

    const { status, rejected } = setCustomCaFile(CA_FILE)

    expect(rejected).toStartWith("The certificate bundle for scripts can't be written: ")
    expect(status).toEqual({ certificates: [] })
    expect(getCustomCaStatus()).toEqual({ certificates: [] })
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM])
    expect(Object.values(caEnv()).every((value) => value === undefined)).toBe(true)
    expect(fs.existsSync(settingPath())).toBe(false)
    expect(leftoverTempFiles()).toEqual([])
  })

  it("keeps the current custom CA when the bundle for a new one can't be written", () => {
    const corpFile = path.join(dataDir, "corp.pem")
    fs.writeFileSync(corpFile, CORP)
    launch()
    setCustomCaFile(CA_FILE)
    blockBundle()

    expect(setCustomCaFile(corpFile).rejected).toStartWith(
      "The certificate bundle for scripts can't be written: ",
    )

    expect(getCustomCaStatus().path).toBe(CA_FILE)
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, CA])
    expect(JSON.parse(fs.readFileSync(settingPath(), "utf8"))).toEqual({ path: CA_FILE })
    expect(process.env.SSL_CERT_FILE).toBe(bundlePath())
    // Retrying writes what it must.
    fs.rmdirSync(bundlePath())
    registerExtraCaPems([EXTRA])
    expect(fs.readFileSync(bundlePath(), "utf8")).toBe(bundleOf([BUNDLED, SYSTEM, EXTRA, CA]))
  })

  it("keeps the current custom CA, saved, when the new one can't be saved", () => {
    const corpFile = path.join(dataDir, "corp.pem")
    fs.writeFileSync(corpFile, CORP)
    launch()
    setCustomCaFile(CA_FILE)
    // The setting is written through this temporary file: as a folder, the write fails.
    fs.mkdirSync(`${settingPath()}.${process.pid}.tmp`)

    expect(setCustomCaFile(corpFile).rejected).toStartWith("The setting can't be saved: ")

    expect(JSON.parse(fs.readFileSync(settingPath(), "utf8"))).toEqual({ path: CA_FILE })
    expect(getCustomCaStatus().path).toBe(CA_FILE)
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, CA])
    expect(fs.readFileSync(bundlePath(), "utf8")).toBe(bundleOf([BUNDLED, SYSTEM, CA]))
  })
})

describe("a saved file that can't be used at launch", () => {
  it("is reported, and trusted no more than no file", () => {
    const gone = path.join(dataDir, "gone.pem")
    fs.writeFileSync(settingPath(), JSON.stringify({ path: gone }))

    launch()

    expect(getCustomCaStatus()).toEqual({
      path: gone,
      certificates: [],
      error: "The file isn't there anymore.",
    })
    expect(fake.installs).toEqual([[BUNDLED, SYSTEM]])
    expect(process.env.SSL_CERT_FILE).toBeUndefined()
  })
})

describe("clearCustomCa", () => {
  it("stops trusting it, forgets it, and puts the env vars back as they were", () => {
    process.env.SSL_CERT_FILE = "/etc/corp.pem"
    launch()
    setCustomCaFile(CA_FILE)
    expect(process.env.SSL_CERT_FILE).toBe(bundlePath())

    expect(clearCustomCa()).toEqual({ status: { certificates: [] } })

    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM])
    expect(process.env.SSL_CERT_FILE).toBe("/etc/corp.pem")
    expect(process.env.GIT_SSL_CAINFO).toBeUndefined()
    expect(fs.existsSync(settingPath())).toBe(false)
  })

  it("keeps the bundle for scripts that are running, without the custom CA", () => {
    launch()
    setCustomCaFile(CA_FILE)

    clearCustomCa()

    // Their env names it, and nothing can change that: deleted, it would fail
    // them even for public servers.
    expect(fs.readFileSync(bundlePath(), "utf8")).toBe(bundleOf([BUNDLED, SYSTEM]))
  })

  it("keeps the custom CA, and says why, when the bundle can't be rewritten without it", () => {
    launch()
    setCustomCaFile(CA_FILE)
    blockBundle()

    const { status, rejected } = clearCustomCa()

    expect(rejected).toStartWith("The certificate bundle for scripts can't be written: ")
    expect(status.path).toBe(CA_FILE)
    expect(getCustomCaStatus().path).toBe(CA_FILE)
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, CA])
    expect(process.env.SSL_CERT_FILE).toBe(bundlePath())
    expect(JSON.parse(fs.readFileSync(settingPath(), "utf8"))).toEqual({ path: CA_FILE })
    fs.rmdirSync(bundlePath())
  })

  it("doesn't put back the bundle itself, inherited by an app a script of this one launched", () => {
    process.env.SSL_CERT_FILE = path.join(dataDir, "custom-ca-bundle.pem")
    launch()
    setCustomCaFile(CA_FILE)

    clearCustomCa()

    expect(process.env.SSL_CERT_FILE).toBeUndefined()
  })
})
