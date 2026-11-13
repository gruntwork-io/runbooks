/**
 * Custom CA certificate: a certificate file the user picks from the menu
 * (Custom CA Certificate…), for servers signed by a private CA that isn't in
 * the OS trust store, such as a self-hosted GitLab or an internal registry.
 * Runbooks trusts its certificates in addition to the ones it already does;
 * verification is never turned off.
 *
 * The trust reaches:
 *  - every Node TLS client in main (the VCS APIs, OAuth, the AWS and Google
 *    SDKs), through system-trust.ts's install;
 *  - every process Runbooks spawns (scripts, git, gh, glab, …), through
 *    CA_BUNDLE_ENV_VARS. They point at a bundle file of everything main
 *    trusts, kept up to date on every install, and go on process.env (which
 *    git spawns and new sessions start from) and on the open session's env.
 *    The bundle is never deleted: a process started while a custom CA was in
 *    use keeps naming it, so removing the custom CA rewrites it without.
 *
 * Not Chromium's network stack (pages and frames), which keeps using the OS
 * trust store alone.
 *
 * The file's path is saved, not its contents (custom-ca.json in userData):
 * like NODE_EXTRA_CA_CERTS and git's http.sslCAInfo, a file renewed in place
 * is picked up on the next launch, or by choosing it again.
 *
 * No electron import, so Bun can test it: index.ts passes the userData path.
 */
import * as fs from "fs"
import * as path from "path"
import { Effect } from "effect"
import {
  CA_BUNDLE_ENV_VARS,
  caBundleEnv,
  caBundleText,
  parseCustomCa,
  pemCertificateBlocks,
} from "../../src/domain/tls/customCa.ts"
import type {
  CaBundleEnvVar,
  CustomCaStatus,
  ParsedCustomCa,
} from "../../src/domain/tls/customCa.ts"
import { errorMessage } from "../../src/errors/message.ts"
import { sessionManager } from "./ipc/runtime.ts"
import { makeLogger } from "./logger.ts"
import { installedCaPems, onTrustInstalled, setCustomCaPems } from "./system-trust.ts"

const log = makeLogger("custom-ca")

/** Where the chosen file's path is saved, in userData. */
const SETTING_FILE = "custom-ca.json"
/** The bundle CA_BUNDLE_ENV_VARS point at, in userData. */
const BUNDLE_FILE = "custom-ca-bundle.pem"
/** Bigger than any certificate bundle: a file this size was picked by mistake. */
const MAX_FILE_BYTES = 10 * 1024 * 1024

interface CustomCaState {
  readonly dataDir: string
  /** The CA_BUNDLE_ENV_VARS values the app started with, restored when the custom CA is removed. */
  readonly originalEnv: Partial<Record<CaBundleEnvVar, string>>
  status: CustomCaStatus
  /** The PEMs of `status`'s certificates, as main trusts them. */
  pems: readonly string[]
  /** Whether CA_BUNDLE_ENV_VARS point at the bundle now. */
  envPointsAtBundle: boolean
  /** The bundle as last written, so an install that changes nothing doesn't rewrite it. */
  writtenBundle: string | undefined
}

let state: CustomCaState | undefined
// Whether syncChildTrust listens to trust installs yet: once per process.
let listening = false

const settingPath = (s: CustomCaState) => path.join(s.dataDir, SETTING_FILE)
const bundlePath = (s: CustomCaState) => path.join(s.dataDir, BUNDLE_FILE)

function ensureInit(): CustomCaState {
  if (!state) throw new Error("initCustomCa() must run first")
  return state
}

/** The saved file path, or undefined when none is saved (or the setting can't be read). */
function readSetting(s: CustomCaState): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingPath(s), "utf8")) as { path?: unknown }
    return typeof parsed.path === "string" && parsed.path.length > 0 ? parsed.path : undefined
  } catch {
    return undefined
  }
}

/** Read and parse a certificate file, with a sentence fit to show the user on failure. */
function readCertificateFile(file: string): ParsedCustomCa {
  try {
    const stat = fs.statSync(file)
    if (stat.isDirectory())
      return { ok: false, error: "That's a folder. Choose a certificate file." }
    if (stat.size > MAX_FILE_BYTES) {
      return { ok: false, error: "The file is too big to be a certificate file." }
    }
    return parseCustomCa(fs.readFileSync(file))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "The file isn't there anymore." }
    }
    return { ok: false, error: `The file can't be read: ${errorMessage(err)}` }
  }
}

/** Set (undefined: unset) env vars on process.env and the open session, if any. */
function setChildEnv(vars: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  // The open session started from process.env before this. With none open,
  // the next one starts from process.env.
  Effect.runSync(Effect.ignore(sessionManager.setStartingEnv(vars)))
}

/**
 * The certificates in the files CA_BUNDLE_ENV_VARS named when the app
 * started. Pointing those vars at the bundle replaces those files, so the
 * bundle carries their certificates on.
 */
function originalFilePems(s: CustomCaState): string[] {
  const pems: string[] = []
  for (const file of new Set(Object.values(s.originalEnv))) {
    try {
      pems.push(...pemCertificateBlocks(fs.readFileSync(file, "utf8")))
    } catch {
      // Gone, unreadable, or a directory: nothing to carry on.
    }
  }
  return pems
}

/**
 * Hand the main process's trust on to spawned processes while a custom CA is
 * in use: write the bundle, and point CA_BUNDLE_ENV_VARS at it. Otherwise put
 * the vars back. Runs after every trust install, so the bundle keeps up with
 * OS-store refreshes and glab harvests. Never throws: main's own trust is
 * already installed by then, and stays.
 */
function syncChildTrust(): void {
  const s = state
  if (!s) return
  try {
    syncChildTrustOrThrow(s)
  } catch (err) {
    log.error("couldn't hand the custom CA on to spawned processes:", err)
  }
}

function syncChildTrustOrThrow(s: CustomCaState): void {
  if (s.status.certificates.length > 0) {
    writeBundle(s)
    if (!s.envPointsAtBundle) {
      setChildEnv(caBundleEnv(bundlePath(s), s.originalEnv))
      s.envPointsAtBundle = true
    }
    return
  }

  if (s.envPointsAtBundle) {
    setChildEnv(caBundleEnv(undefined, s.originalEnv))
    s.envPointsAtBundle = false
  }
  // A process started while a custom CA was in use, in this run or an earlier
  // one, still names the bundle and can't be told otherwise. Deleting it would
  // leave that process with a missing CA file, failing even for public
  // servers: it holds what main trusts without the custom CA instead.
  if (s.writtenBundle !== undefined || fs.existsSync(bundlePath(s))) writeBundle(s)
}

/** Write the bundle: everything main trusts, and the certificates of the files the vars named at launch. */
function writeBundle(s: CustomCaState): void {
  const bundle = caBundleText([...installedCaPems(), ...originalFilePems(s)])
  if (bundle === s.writtenBundle) return
  // Through a temporary file, so a script that is running never reads half of it.
  const tmp = `${bundlePath(s)}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, bundle, { mode: 0o644 })
    fs.renameSync(tmp, bundlePath(s))
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // The error to report is the write's.
    }
    throw err
  }
  s.writtenBundle = bundle
}

/**
 * Make `status` the custom CA setting, and trust `pems`, its certificates, in
 * main. The install hands them on to spawned processes, but only as far as
 * syncChildTrust can: a caller that must know runs syncChildTrustOrThrow.
 */
function trust(s: CustomCaState, status: CustomCaStatus, pems: readonly string[]): void {
  s.status = status
  s.pems = pems
  setCustomCaPems([...pems])
}

/**
 * Load the saved custom CA, if any, and trust it. Call once at startup, after
 * populateShellEnv() (so the env vars it may replace are the user's) and
 * initSystemTrust(), before any TLS connection, and only in the instance that
 * holds the single-instance lock: the bundle is that instance's.
 */
export function initCustomCa(io: { dataDir: string }): void {
  const bundle = path.join(io.dataDir, BUNDLE_FILE)
  const originalEnv: Partial<Record<CaBundleEnvVar, string>> = {}
  const inherited: Partial<Record<CaBundleEnvVar, undefined>> = {}
  for (const name of CA_BUNDLE_ENV_VARS) {
    const value = process.env[name]
    if (!value) continue
    // The bundle itself, inherited by an app launched from a script an
    // earlier run ran: what it stood in for is unknown, so it's neither
    // restored nor handed on. With a custom CA in use it's set again below.
    if (path.resolve(value) === bundle) inherited[name] = undefined
    else originalEnv[name] = value
  }
  setChildEnv(inherited)
  state = {
    dataDir: io.dataDir,
    originalEnv,
    status: { certificates: [] },
    pems: [],
    envPointsAtBundle: false,
    writtenBundle: undefined,
  }
  const s = state
  if (!listening) {
    onTrustInstalled(syncChildTrust)
    listening = true
  }

  const file = readSetting(s)
  if (file !== undefined) {
    const parsed = readCertificateFile(file)
    if (parsed.ok) {
      trust(s, { path: file, certificates: parsed.certificates }, parsed.pems)
      log.info(`custom CA: ${parsed.certificates.length} certificate(s) from ${file}`)
    } else {
      log.warn(`custom CA ${file} not trusted: ${parsed.error}`)
      s.status = { path: file, certificates: [], error: parsed.error }
    }
  }
  // Without a custom CA in use, this takes it out of a bundle left over from
  // an earlier run.
  syncChildTrust()
}

/** The custom CA setting, for the Custom CA Certificate dialog. */
export function getCustomCaStatus(): CustomCaStatus {
  return ensureInit().status
}

/**
 * Trust the certificates in `file` as the custom CA, in place of any set
 * before, in main and in spawned processes, and save the choice. A file
 * without a usable certificate, or one that can't be handed on to spawned
 * processes or saved, changes nothing: `rejected` says why.
 */
export function setCustomCaFile(file: string): { status: CustomCaStatus; rejected?: string } {
  const s = ensureInit()
  const parsed = readCertificateFile(file)
  if (!parsed.ok) return { status: s.status, rejected: parsed.error }

  const before = { status: s.status, pems: s.pems }
  const undo = (rejected: string) => {
    trust(s, before.status, before.pems)
    syncChildTrust()
    return { status: s.status, rejected }
  }

  trust(s, { path: file, certificates: parsed.certificates }, parsed.pems)
  try {
    syncChildTrustOrThrow(s)
  } catch (err) {
    log.error("couldn't hand the custom CA on to spawned processes:", err)
    return undo(`The certificate bundle for scripts can't be written: ${errorMessage(err)}`)
  }
  try {
    fs.writeFileSync(settingPath(s), JSON.stringify({ path: file }), "utf8")
  } catch (err) {
    return undo(`The setting can't be saved: ${errorMessage(err)}`)
  }
  log.info(`custom CA: ${parsed.certificates.length} certificate(s) from ${file}`)
  return { status: s.status }
}

/** Stop trusting the custom CA, and forget it. */
export function clearCustomCa(): CustomCaStatus {
  const s = ensureInit()
  fs.rmSync(settingPath(s), { force: true })
  trust(s, { certificates: [] }, [])
  syncChildTrust()
  log.info("custom CA removed")
  return s.status
}
