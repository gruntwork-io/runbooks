/**
 * Mixpanel telemetry.
 *
 * Singleton pattern: call init() once at startup, then track()/trackCommand()/trackError().
 * Telemetry is anonymous (SHA256 of hostname+username) and can be disabled via
 * RUNBOOKS_TELEMETRY_DISABLE env var or CLI flag.
 *
 * Collected: commands used, OS, arch, version, error types.
 * NOT collected: file content, paths, personal info.
 *
 * Docs: https://runbooks.gruntwork.io/security/telemetry/
 */
import * as os from "os"
import * as crypto from "crypto"
import { Effect } from "effect"
import type { TelemetryShape } from "./services/Telemetry.ts"

// ---------------------------------------------------------------------------
// Build-time / env constant
// ---------------------------------------------------------------------------

const MIXPANEL_TOKEN_FALLBACK = ""
const TELEMETRY_DOCS_URL = "https://runbooks.gruntwork.io/security/telemetry/"
const DISABLE_ENV_VAR = "RUNBOOKS_TELEMETRY_DISABLE"

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let enabled = false
let appVersion = "unknown"
let anonymousId: string | undefined
let mixpanelClient: ReturnType<typeof import("mixpanel")["init"]> | undefined

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize telemetry. Must be called once before any tracking.
 *
 * Disabled when:
 * - `disabledByFlag` is true (CLI --no-telemetry)
 * - RUNBOOKS_TELEMETRY_DISABLE env var is set to any truthy value
 */
export function init(version: string, disabledByFlag: boolean): void {
  appVersion = version

  const envDisabled = isTruthyEnv(process.env[DISABLE_ENV_VAR])
  if (disabledByFlag || envDisabled) {
    enabled = false
    return
  }

  const token = process.env.MIXPANEL_TOKEN ?? MIXPANEL_TOKEN_FALLBACK
  if (!token) {
    enabled = false
    return
  }

  try {
    // Dynamic import not needed -- mixpanel is a regular CJS dep
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Mixpanel = require("mixpanel") as typeof import("mixpanel")
    mixpanelClient = Mixpanel.init(token, { protocol: "https" })
    anonymousId = generateAnonymousId()
    enabled = true
  } catch {
    // If mixpanel fails to load (e.g. missing dep in dev), silently disable.
    enabled = false
  }
}

/** Whether telemetry is currently active. */
export function isEnabled(): boolean {
  return enabled
}

/** Returns config info suitable for an API health-check response. */
export function getConfig(): { enabled: boolean; token: string | undefined } {
  return {
    enabled,
    token: enabled ? (process.env.MIXPANEL_TOKEN ?? MIXPANEL_TOKEN_FALLBACK) : undefined,
  }
}

/**
 * Track an event with optional properties. Fire-and-forget: never throws,
 * never blocks the caller.
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!enabled || !mixpanelClient) return

  try {
    mixpanelClient.track(event, {
      distinct_id: anonymousId,
      version: appVersion,
      os: process.platform,
      arch: process.arch,
      node_version: process.version,
      ...properties,
    })
  } catch {
    // Silently swallow -- telemetry must never disrupt the app.
  }
}

/** Convenience: track a CLI command invocation. */
export function trackCommand(command: string): void {
  track("command", { command })
}

/** Track error type (NOT content) for aggregate error reporting. */
export function trackError(errorType: string): void {
  track("error", { error_type: errorType })
}

/**
 * Generate a stable anonymous ID from hostname + username.
 * SHA-256 ensures no PII is transmitted.
 */
export function generateAnonymousId(): string {
  const hostname = os.hostname()
  const username = os.userInfo().username
  return crypto.createHash("sha256").update(`${hostname}:${username}`).digest("hex")
}

/** Print opt-out notice to stderr (shown once on first run). */
export function printNotice(): void {
  console.error(
    [
      "",
      "Gruntwork Runbooks collects anonymous usage telemetry to improve the product.",
      `To learn more or opt out, visit: ${TELEMETRY_DOCS_URL}`,
      `To disable: set ${DISABLE_ENV_VAR}=1`,
      "",
    ].join("\n"),
  )
}

/**
 * Gracefully flush pending events. Call on process exit.
 * Returns a promise that resolves after a short timeout so we don't
 * block shutdown indefinitely.
 */
export function shutdown(): Promise<void> {
  if (!enabled || !mixpanelClient) return Promise.resolve()

  // Mixpanel Node SDK doesn't expose a flush/close, so we just give a brief
  // window for in-flight HTTP requests to complete.
  return new Promise((resolve) => setTimeout(resolve, 500))
}

// ---------------------------------------------------------------------------
// Effect-based service implementation
// ---------------------------------------------------------------------------

/**
 * Creates a TelemetryShape backed by the singleton above.
 * Useful for providing the Telemetry service in the Effect context.
 */
export function makeTelemetryService(): TelemetryShape {
  return {
    track: (event, properties) =>
      Effect.sync(() => track(event, properties)),
    trackCommand: (command) =>
      Effect.sync(() => trackCommand(command)),
    trackError: (errorType) =>
      Effect.sync(() => trackError(errorType)),
    isEnabled: () =>
      Effect.sync(() => isEnabled()),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const lower = value.toLowerCase()
  return lower === "1" || lower === "true" || lower === "yes"
}
