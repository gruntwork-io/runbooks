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
} from "../../src/domain/tls/custom-ca.ts"
import type {
  CaBundleEnvVar,
  CustomCaStatus,
  ParsedCustomCa,
} from "../../src/domain/tls/custom-ca.ts"
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
 * the vars back and delete the bundle. Runs after every trust install, so the
 * bundle keeps up with OS-store refreshes and glab harvests. Never throws:
 * main's own trust is already installed by then, and stays.
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
  const inUse = s.status.certificates.length > 0

  if (!inUse) {
    if (s.envPointsAtBundle) {
      setChildEnv(caBundleEnv(undefined, s.originalEnv))
      s.envPointsAtBundle = false
    }
    if (s.writtenBundle !== undefined || fs.existsSync(bundlePath(s))) {
      fs.rmSync(bundlePath(s), { force: true })
      s.writtenBundle = undefined
    }
    return
  }

  const bundle = caBundleText([...installedCaPems(), ...originalFilePems(s)])
  if (bundle !== s.writtenBundle) {
    // Through a temporary file, so a script that is running never reads half of it.
    const tmp = `${bundlePath(s)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, bundle, { mode: 0o644 })
    fs.renameSync(tmp, bundlePath(s))
    s.writtenBundle = bundle
  }
  if (!s.envPointsAtBundle) {
    setChildEnv(caBundleEnv(bundlePath(s), s.originalEnv))
    s.envPointsAtBundle = true
  }
}

/** Trust `parsed`'s certificates as the custom CA from `file`. */
function trust(
  s: CustomCaState,
  file: string,
  parsed: Extract<ParsedCustomCa, { ok: true }>,
): void {
  s.status = { path: file, certificates: parsed.certificates }
  setCustomCaPems(parsed.pems)
  syncChildTrust()
  log.info(`custom CA: ${parsed.certificates.length} certificate(s) from ${file}`)
}

/**
 * Load the saved custom CA, if any, and trust it. Call once at startup, after
 * populateShellEnv() (so the env vars it may replace are the user's) and
 * initSystemTrust(), before any TLS connection.
 */
export function initCustomCa(io: { dataDir: string }): void {
  const bundle = path.join(io.dataDir, BUNDLE_FILE)
  const originalEnv: Partial<Record<CaBundleEnvVar, string>> = {}
  for (const name of CA_BUNDLE_ENV_VARS) {
    const value = process.env[name]
    // The bundle itself is inherited by an app launched from a script this
    // app ran: what it stood in for is unknown, so it's not restored.
    if (value && path.resolve(value) !== bundle) originalEnv[name] = value
  }
  state = {
    dataDir: io.dataDir,
    originalEnv,
    status: { certificates: [] },
    envPointsAtBundle: false,
    writtenBundle: undefined,
  }
  const s = state
  if (!listening) {
    onTrustInstalled(syncChildTrust)
    listening = true
  }

  const file = readSetting(s)
  if (file === undefined) {
    // Left over from a run that didn't remove it, e.g. one that crashed.
    syncChildTrust()
    return
  }
  const parsed = readCertificateFile(file)
  if (!parsed.ok) {
    log.warn(`custom CA ${file} not trusted: ${parsed.error}`)
    s.status = { path: file, certificates: [], error: parsed.error }
    syncChildTrust()
    return
  }
  trust(s, file, parsed)
}

/** The custom CA setting, for the Custom CA Certificate dialog. */
export function getCustomCaStatus(): CustomCaStatus {
  return ensureInit().status
}

/**
 * Trust the certificates in `file` as the custom CA, in place of any set
 * before, and save the choice. A file without a usable certificate changes
 * nothing: `rejected` says why.
 */
export function setCustomCaFile(file: string): { status: CustomCaStatus; rejected?: string } {
  const s = ensureInit()
  const parsed = readCertificateFile(file)
  if (!parsed.ok) return { status: s.status, rejected: parsed.error }
  try {
    fs.writeFileSync(settingPath(s), JSON.stringify({ path: file }), "utf8")
  } catch (err) {
    return { status: s.status, rejected: `The setting can't be saved: ${errorMessage(err)}` }
  }
  trust(s, file, parsed)
  return { status: s.status }
}

/** Stop trusting the custom CA, and forget it. */
export function clearCustomCa(): CustomCaStatus {
  const s = ensureInit()
  fs.rmSync(settingPath(s), { force: true })
  s.status = { certificates: [] }
  setCustomCaPems([])
  syncChildTrust()
  log.info("custom CA removed")
  return s.status
}
