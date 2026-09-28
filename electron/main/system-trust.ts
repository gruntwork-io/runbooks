/**
 * System-trust TLS: make every Node TLS client in the main process (VCS
 * HttpClient layers, OAuth device flow, AWS SDK, Mixpanel) honor the OS trust
 * store in ADDITION to Node's bundled Mozilla roots, so a custom enterprise
 * root CA installed in the OS store stops failing token validation as
 * "Invalid credentials detected". Strictly additive — verification is never
 * disabled.
 *
 * index.ts calls initSystemTrust() once at startup, before any TLS
 * connection; the IPC handlers call refreshSystemTrust() and
 * registerExtraCaPems(). This lives outside the entry module so those
 * handlers can import it without an import cycle. Nothing touches node:tls
 * until initSystemTrust() runs, and the tls calls are injectable: Bun (the
 * unit-test runtime) has no tls.setDefaultCACertificates.
 */
import * as fs from "fs"
import * as tls from "node:tls"
import { Effect } from "effect"
import { coldReadSystemPems, installSystemTrust, refreshSystemPems } from "../../src/domain/tls/system-ca.ts"
import type { CaSources } from "../../src/domain/tls/system-ca.ts"
import { runtime } from "./ipc/runtime.ts"
import { makeLogger } from "./logger.ts"

// Same tag as when this lived in index.ts, so the trust log lines are unchanged.
const log = makeLogger("main")

/** The node:tls calls system trust makes. */
export interface TrustTls {
  readonly getCACertificates: (type: "default" | "system") => string[]
  readonly setDefaultCACertificates: (certs: string[]) => void
}

interface TrustState {
  readonly tls: TrustTls
  // Snapshot of the bundled defaults, taken BEFORE the first
  // setDefaultCACertificates: afterwards getCACertificates("default") returns
  // the previously-installed union, so re-reading "default" later would
  // compound extras into the base.
  readonly bundledCaDefaults: readonly string[] // Mozilla roots + NODE_EXTRA_CA_CERTS
  // "system" reads are cached for process lifetime and trust install is
  // per-thread — see the CAVEATS in system-ca.ts.
  lastKnownSystemPems: string[]
  // Extra PEMs beyond the OS store (glab per-host ca_cert contents — the
  // harvest, wired in during host enumeration). Re-installs always include them.
  harvestedCaPems: string[]
}

let state: TrustState | undefined

// Dev/test-only extraPems seam: RUNBOOKS_TEST_EXTRA_CA points at a PEM
// file read FRESH on every install/refresh, so an e2e can inject a CA
// mid-session and assert the TLS card's Retry recovers without relaunch. The
// OS-store-mutated leg is physically untestable in CI (no keychain mutation)
// and is covered by the manual QA gate.
function testSeamPems(): string[] {
  const seamPath = process.env.RUNBOOKS_TEST_EXTRA_CA
  if (!seamPath) return []
  try {
    const pem = fs.readFileSync(seamPath, "utf8")
    return pem.includes("-----BEGIN CERTIFICATE-----") ? [pem] : []
  } catch {
    return []
  }
}

const extraPemsForInstall = (s: TrustState): string[] => [...s.harvestedCaPems, ...testSeamPems()]

const caSources = (s: TrustState, systemPems: string[]): CaSources => ({
  bundledDefaults: () => [...s.bundledCaDefaults],
  systemPems: () => Effect.succeed(systemPems),
  setCAs: (certs) => s.tls.setDefaultCACertificates(certs),
})

// The count log line doubles as the e2e trust canary (asserts system > 0
// on the macOS runner) — keep its format stable.
function installAndLog(s: TrustState, systemPems: string[], note?: string): void {
  const counts = Effect.runSync(installSystemTrust(extraPemsForInstall(s), caSources(s, systemPems)))
  log.info(
    `installSystemTrust: defaults=${counts.defaults} system=${counts.system} extra=${counts.extra}${note ? ` (${note})` : ""}`,
  )
}

// Every install must include the bundled snapshot: setDefaultCACertificates
// REPLACES the list, so a union without it would drop the Mozilla roots and
// break every TLS connection. Hence no install of any kind before init.
function ensureInit(): TrustState {
  if (!state) {
    throw new Error("initSystemTrust() must run before trust can be refreshed or extended")
  }
  return state
}

/**
 * The launch-time install: snapshot the bundled defaults and the OS store,
 * then install their union. Call once at startup, before any TLS connection.
 * `tls` is a test seam; it defaults to node:tls.
 */
export function initSystemTrust(io: { tls?: TrustTls } = {}): void {
  const trustTls = io.tls ?? tls
  state = {
    tls: trustTls,
    bundledCaDefaults: [...trustTls.getCACertificates("default")],
    lastKnownSystemPems: [...trustTls.getCACertificates("system")],
    harvestedCaPems: [],
  }
  installAndLog(state, state.lastKnownSystemPems)
}

/**
 * Mid-session trust refresh. Node caches getCACertificates("system")
 * for process lifetime, so a CA installed after launch is only observable via
 * a COLD out-of-process read (process.execPath with ELECTRON_RUN_AS_NODE=1).
 * On any child failure the launch-time set is used instead — never worse than
 * launch. Returns coldReadOk so callers can degrade the TLS-card copy to
 * "…then restart Runbooks" when the child itself failed.
 *
 * Runs on: every TLS-classified validation failure (once, before any error
 * surfaces), the TLS card's Retry, HostSelect Reload, and GitHub Check again.
 */
export async function refreshSystemTrust(): Promise<{ coldReadOk: boolean }> {
  const s = ensureInit()
  const { pems, coldReadOk } = await runtime.runPromise(
    refreshSystemPems(coldReadSystemPems(), s.lastKnownSystemPems),
  )
  if (coldReadOk) {
    s.lastKnownSystemPems = [...pems]
  }
  installAndLog(s, pems, `refresh, coldReadOk=${coldReadOk}`)
  return { coldReadOk }
}

/**
 * Register extra trust PEMs harvested from glab per-host `ca_cert` config
 * and re-install the union. Strictly additive; idempotent. Called from
 * the gitlab:enumerate-hosts handler on every host enumeration.
 */
export function registerExtraCaPems(pems: string[]): void {
  const s = ensureInit()
  const unchanged =
    pems.length === s.harvestedCaPems.length && pems.every((pem, i) => pem === s.harvestedCaPems[i])
  if (unchanged) return
  s.harvestedCaPems = [...pems]
  installAndLog(s, s.lastKnownSystemPems, "glab ca_cert harvest")
}
