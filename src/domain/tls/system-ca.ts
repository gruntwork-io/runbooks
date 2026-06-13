/**
 * System-trust TLS domain module (vcs-auth-v2-design.md §3.1).
 *
 * `installSystemTrust` unions the launch-time bundled-defaults snapshot with
 * OS-installed roots plus any extra PEMs (glab per-host `ca_cert` contents,
 * test seam), dedupes, and installs the result as the process-default CA
 * list. Strictly additive: the bundled snapshot is always part of the union
 * and verification is never disabled.
 *
 * CAVEATS:
 * - tls.setDefaultCACertificates is per-thread — trust must be installed
 *   again in any future worker_threads/utilityProcess (none exist today).
 * - The union must be installed before the first cacheable TLS connection.
 * - tls.getCACertificates("system") is cached for process lifetime (Node 24
 *   lib/tls.js), so a mid-session refresh can never observe a newly installed
 *   CA in-process. The refresh path is a cold out-of-process read
 *   (`coldReadSystemPems`), falling back to the launch-time set on any child
 *   failure (`refreshSystemPems`) — never worse than launch.
 *
 * The module itself never touches node:tls — all I/O arrives via the
 * injectable `CaSources`, which keeps it pure, Bun-test-safe (Bun 1.3.x has
 * no tls.setDefaultCACertificates), and trivially fakeable.
 */
import { Effect, Stream } from "effect"
import { ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { VCS_TOKEN_ENV_VARS } from "../vcs/redact.ts"
import type { VcsTransportErrorKind } from "../../errors/index.ts"

// ---------------------------------------------------------------------------
// Trust installation
// ---------------------------------------------------------------------------

export interface CaSources {
  /** The startup snapshot of getCACertificates("default") — never re-read
   *  "default" after the first setDefaultCACertificates call (it would return
   *  the previously-installed union and compound extras into the base). */
  readonly bundledDefaults: () => string[]
  /** Launch: in-process getCACertificates("system").
   *  Refresh: the cold out-of-process read (with launch-set fallback). */
  readonly systemPems: () => Effect.Effect<string[]>
  /** tls.setDefaultCACertificates */
  readonly setCAs: (certs: string[]) => void
}

/** Source counts (pre-dedupe) of one trust install, for logging. */
export interface TrustCounts {
  readonly defaults: number
  readonly system: number
  readonly extra: number
}

/** Dedupe PEM blocks by trimmed content, preserving first-seen order. */
export const dedupePems = (pems: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const pem of pems) {
    const key = pem.trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(pem)
  }
  return out
}

/**
 * Union the bundled-default snapshot with OS-installed roots plus any extra
 * PEMs (glab per-host ca_cert contents, test seam), dedupe, and install as
 * the process-default CA list. Returns counts for logging. Idempotent; safe
 * to re-run (the snapshot discipline in CaSources prevents compounding).
 */
export const installSystemTrust = (
  extraPems: string[],
  io: CaSources,
): Effect.Effect<TrustCounts> =>
  Effect.gen(function* () {
    const defaults = io.bundledDefaults()
    const system = yield* io.systemPems()
    io.setCAs(dedupePems([...defaults, ...system, ...extraPems]))
    return { defaults: defaults.length, system: system.length, extra: extraPems.length }
  })

// ---------------------------------------------------------------------------
// Cold out-of-process system-store read (the mid-session refresh mechanism)
// ---------------------------------------------------------------------------

const COLD_READ_TIMEOUT_MS = 10_000

// The cold-read child receives no token env at all (§8).
const coldReadChildEnv = (): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  for (const name of VCS_TOKEN_ENV_VARS) {
    delete env[name]
  }
  return env
}

/**
 * Read the OS trust store from a fresh child process. A fresh process has an
 * empty getCACertificates("system") cache and performs a real OS-store query
 * — the only way to observe a CA installed after this process launched.
 *
 * Spawns `process.execPath` with ELECTRON_RUN_AS_NODE=1 (turns the Electron
 * binary into plain Node; harmless for an actual node binary) and parses the
 * JSON PEM array from stdout. Fails on spawn error, timeout, non-zero exit,
 * or unparseable output — callers fall back via `refreshSystemPems`.
 */
export const coldReadSystemPems = (
  execPath: string = process.execPath,
  timeoutMs: number = COLD_READ_TIMEOUT_MS,
): Effect.Effect<string[], Error, ProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const proc = yield* spawner.spawn(
      execPath,
      ["-p", "JSON.stringify(require('node:tls').getCACertificates('system'))"],
      { env: coldReadChildEnv() },
    )
    const stdout: string[] = []
    const exitCode = yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* proc.output.pipe(
          Stream.filter((line) => line.source === "stdout"),
          Stream.runForEach((line) => Effect.sync(() => stdout.push(line.line))),
          Effect.timeout(timeoutMs),
        )
        return yield* proc.exitCode.pipe(Effect.timeout(timeoutMs))
      }),
      proc.kill.pipe(Effect.ignore),
    )
    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`cold system-CA read exited with code ${exitCode}`))
    }
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(stdout.join("\n")),
      catch: (err) => new Error(`cold system-CA read produced unparseable stdout: ${err}`),
    })
    if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
      return yield* Effect.fail(new Error("cold system-CA read did not return a JSON string array"))
    }
    return parsed
  }).pipe(
    Effect.mapError((err) => (err instanceof Error ? err : new Error(`cold system-CA read failed: ${err}`))),
  )

/**
 * Compose a cold read with the launch-time fallback: on any child failure
 * (spawn error, timeout, unparseable stdout) the launch set is used — never
 * worse than launch. `coldReadOk` lets callers degrade the TLS-card copy to
 * "…then restart Runbooks" when the child itself failed (§3.1 fallback).
 */
export const refreshSystemPems = <R>(
  coldRead: Effect.Effect<string[], Error, R>,
  launchSet: readonly string[],
): Effect.Effect<{ pems: string[]; coldReadOk: boolean }, never, R> =>
  coldRead.pipe(
    Effect.map((pems) => ({ pems, coldReadOk: true })),
    Effect.catchAll(() => Effect.succeed({ pems: [...launchSet], coldReadOk: false })),
  )

// ---------------------------------------------------------------------------
// TLS / network error classification (the misdiagnosis fix's foundation)
// ---------------------------------------------------------------------------

/** Trust-store fixable (→ refresh + probe + CA-install card). */
const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  // Chromium code, should net.fetch ever be adopted (§3.2 escape route).
  "ERR_CERT_AUTHORITY_INVALID",
])

/** NOT fixable by trust changes (→ admin card, no refresh/probe). */
const SERVER_CERT_CODES = new Set(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"])

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  // OpenSSL protocol-level handshake failure (e.g. an https probe against a
  // plain-http port) — a transport problem, never a credential one.
  "EPROTO",
  // undici reports connect timeouts with its own code, not ETIMEDOUT.
  "UND_ERR_CONNECT_TIMEOUT",
])

const collectErrorCodes = (err: unknown, seen: Set<unknown>): string[] => {
  if (err === null || typeof err !== "object" || seen.has(err)) return []
  seen.add(err)
  const codes: string[] = []
  const code = (err as { code?: unknown }).code
  if (typeof code === "string") codes.push(code)
  // AggregateError (e.g. parallel connect attempts across resolved addresses).
  const errors = (err as { errors?: unknown }).errors
  if (Array.isArray(errors)) {
    for (const inner of errors) codes.push(...collectErrorCodes(inner, seen))
  }
  codes.push(...collectErrorCodes((err as { cause?: unknown }).cause, seen))
  return codes
}

/**
 * Classify a transport-level failure into the tri-state error kinds (§3.1).
 *
 * Unwraps the cause chain FIRST: undici's global fetch rejects with
 * TypeError("fetch failed") carrying the OpenSSL code on error.cause,
 * sometimes nested inside AggregateError.errors — without unwrapping,
 * everything would classify as undefined.
 *
 * Returns undefined for anything that is not a recognized transport failure
 * (e.g. an HTTP 401 — that is an auth outcome, never a transport one).
 */
export const classifyTlsError = (err: unknown): VcsTransportErrorKind | undefined => {
  const codes = collectErrorCodes(err, new Set())
  if (codes.some((code) => TLS_TRUST_CODES.has(code))) return "tls"
  if (codes.some((code) => SERVER_CERT_CODES.has(code))) return "server-cert"
  if (codes.some((code) => NETWORK_CODES.has(code))) return "network"
  return undefined
}
