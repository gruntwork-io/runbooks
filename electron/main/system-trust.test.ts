import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { Effect } from "effect"
import { runtime } from "./ipc/runtime.ts"
import { initSystemTrust, refreshSystemTrust, registerExtraCaPems } from "./system-trust.ts"
import type { TrustTls } from "./system-trust.ts"
import { makeRecordingSpawner } from "../../src/test-utils/TestSpawner.ts"
import type { SpawnResponse } from "../../src/test-utils/TestSpawner.ts"

const pem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`
const BUNDLED = pem("BUNDLED")
const SYSTEM = pem("SYSTEM")
const NEW_SYSTEM = pem("NEW-SYSTEM")
const EXTRA = pem("EXTRA")

/**
 * A fake node:tls that behaves like the real one where it matters: after an
 * install, getCACertificates("default") returns the installed union, so any
 * code that re-read "default" instead of keeping the launch snapshot would
 * compound extras into the base.
 */
const makeFakeTls = (bundled: string[], system: string[]) => {
  let current = [...bundled]
  const installs: string[][] = []
  const tls: TrustTls = {
    getCACertificates: (type) => [...(type === "default" ? current : system)],
    setDefaultCACertificates: (certs) => {
      current = [...certs]
      installs.push([...certs])
    },
  }
  return { tls, installs, lastInstall: () => installs[installs.length - 1] }
}

/** The cold-read child's reply: the OS store as a JSON array on stdout. */
const coldReadOk = (pems: string[]): SpawnResponse => ({
  lines: [{ source: "stdout", line: JSON.stringify(pems) }],
  exitCode: 0,
})

let fake: ReturnType<typeof makeFakeTls>
let coldRead: SpawnResponse | "ENOENT"
let logs: ReturnType<typeof spyOn<Console, "log">>

beforeEach(() => {
  coldRead = "ENOENT"
  // The refresh runs the cold read on the app runtime; run it against a fake
  // ProcessSpawner instead of building the whole AppLive layer.
  const spawner = makeRecordingSpawner(() => coldRead)
  spyOn(runtime, "runPromise").mockImplementation(((effect: Effect.Effect<unknown, unknown, never>) =>
    Effect.runPromise(Effect.provide(effect, spawner.layer))) as typeof runtime.runPromise)
  logs = spyOn(console, "log").mockImplementation(() => {})

  fake = makeFakeTls([BUNDLED], [SYSTEM])
  initSystemTrust({ tls: fake.tls })
})

afterEach(() => {
  mock.restore()
})

describe("initSystemTrust", () => {
  it("installs the bundled defaults plus the OS store and logs the canary counts", () => {
    expect(fake.installs).toEqual([[BUNDLED, SYSTEM]])
    expect(logs).toHaveBeenCalledWith("[main]", "installSystemTrust: defaults=1 system=1 extra=0")
  })
})

describe("registerExtraCaPems", () => {
  it("re-installs bundled + system + the harvested PEMs when the set changes", () => {
    registerExtraCaPems([EXTRA])

    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, EXTRA])
    expect(logs).toHaveBeenCalledWith(
      "[main]",
      "installSystemTrust: defaults=1 system=1 extra=1 (glab ca_cert harvest)",
    )
  })

  it("does not re-install when the set is unchanged", () => {
    registerExtraCaPems([])
    registerExtraCaPems([EXTRA])
    registerExtraCaPems([EXTRA])

    // The launch install plus the one real change.
    expect(fake.installs).toHaveLength(2)
  })

  it("replaces the harvested set rather than accumulating it", () => {
    registerExtraCaPems([EXTRA])
    registerExtraCaPems([])

    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM])
  })
})

describe("refreshSystemTrust", () => {
  it("installs the cold-read OS store and keeps it for later installs", async () => {
    coldRead = coldReadOk([SYSTEM, NEW_SYSTEM])

    expect(await refreshSystemTrust()).toEqual({ coldReadOk: true })
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, NEW_SYSTEM])
    expect(logs).toHaveBeenCalledWith(
      "[main]",
      "installSystemTrust: defaults=1 system=2 extra=0 (refresh, coldReadOk=true)",
    )

    // A later harvest re-install uses the refreshed set...
    registerExtraCaPems([EXTRA])
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, NEW_SYSTEM, EXTRA])

    // ...and so does the fallback when a later cold read fails.
    coldRead = "ENOENT"
    expect(await refreshSystemTrust()).toEqual({ coldReadOk: false })
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM, NEW_SYSTEM, EXTRA])
  })

  it("falls back to the launch-time set when the cold read fails", async () => {
    coldRead = { lines: [], exitCode: 1 }

    expect(await refreshSystemTrust()).toEqual({ coldReadOk: false })
    expect(fake.lastInstall()).toEqual([BUNDLED, SYSTEM])
    expect(logs).toHaveBeenCalledWith(
      "[main]",
      "installSystemTrust: defaults=1 system=1 extra=0 (refresh, coldReadOk=false)",
    )
  })
})

describe("before initSystemTrust", () => {
  it("refuses to install at all, so no install can lack the bundled roots", async () => {
    // A fresh module instance (Bun caches modules by full specifier), so its
    // state is uninitialized whatever ran before this test.
    const specifier = "./system-trust.ts?before-init"
    const fresh: typeof import("./system-trust.ts") = await import(specifier)

    expect(() => fresh.registerExtraCaPems([EXTRA])).toThrow("initSystemTrust() must run")
    await expect(fresh.refreshSystemTrust()).rejects.toThrow("initSystemTrust() must run")
  })
})
