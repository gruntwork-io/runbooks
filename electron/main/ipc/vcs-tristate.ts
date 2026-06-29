/**
 * Shared tri-state orchestration for the GitAuth IPC handlers.
 * On a TLS-classified failure, run the cold
 * out-of-process trust refresh ONCE and retry; if the wall persists and a CLI
 * is eligible, run the validation-only probe; degrade to the error card
 * otherwise. server-cert and network failures get NO refresh and NO probe —
 * they cannot help. This lives Electron-side because the refresh needs the
 * cold-read child wired in electron/main/index.ts; the VcsCredentials service
 * stays Bun-test-safe.
 */
import { Effect, Exit } from "effect"
import { runtime, sessionManager, vcsSessionMeta } from "./runtime.ts"
import type { GitProvider } from "./runtime.ts"
import { VcsCredentials } from "../../../src/services/VcsCredentials.ts"
import type {
  DetectionResult,
  VcsCredentialSource,
  VcsProvider,
} from "../../../src/services/VcsCredentials.ts"
import { redactSecrets, registerSecret } from "../../../src/domain/vcs/redact.ts"
import { refreshSystemTrust } from "../index.ts"
import { getMainWindow } from "../window.ts"

/**
 * Record a successful session-env credential write and push the
 * vcs:session-changed event: the session holds one credential per
 * provider, so every write may invalidate another block's success card.
 */
export function recordSessionAuth(provider: GitProvider, host: string, source?: string): void {
  vcsSessionMeta.set(provider, { host, source })
  getMainWindow()?.webContents.send("vcs:session-changed", { provider, host, source })
}

export interface OrchestratedDetection extends DetectionResult {
  readonly coldReadOk?: boolean
}

/**
 * The session-credential write: append the env vars, then record the auth
 * and broadcast vcs:session-changed. A failed write must never void a
 * credential the API just validated — it returns the success-card warning
 * copy (`sessionEnvWarning`) instead of failing; undefined on success.
 */
export async function appendSessionEnvAndRecord(
  provider: GitProvider,
  host: string,
  source: string | undefined,
  env: Record<string, string>,
): Promise<string | undefined> {
  try {
    await runtime.runPromise(sessionManager.appendToEnv(env))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `Authenticated, but the credential could not be saved to the session (${redactSecrets(message)}). Blocks that consume it may not see it.`
  }
  recordSessionAuth(provider, host, source)
  return undefined
}

export const withVcs = <A>(
  use: (vcs: VcsCredentials["Type"]) => Effect.Effect<A>,
): Promise<A> => runtime.runPromise(Effect.flatMap(VcsCredentials, use))

/**
 * Run a detection/validation step with the TLS recovery ladder:
 * cold trust refresh → retry → CLI probe → error card.
 * `probeSource` overrides the result's source for probe gating (the PAT path
 * passes "manual" — env-sourced/manual OAuth-shaped GitLab tokens are never
 * probed via token injection).
 */
export async function withTlsOrchestration(opts: {
  provider: VcsProvider
  host: string
  detect: () => Promise<DetectionResult>
  probeSource?: VcsCredentialSource
}): Promise<OrchestratedDetection> {
  let result = await opts.detect()
  if (result.outcome !== "unreachable" || result.errorKind !== "tls") return result

  // (a) automatic cold refresh, once, before any error surfaces.
  const { coldReadOk } = await refreshSystemTrust()
  result = await opts.detect()
  if (result.outcome !== "unreachable" || result.errorKind !== "tls") return result

  // (b) CLI validation fallback — validation-only, never a transport.
  const probeSource = opts.probeSource ?? result.source
  if (result.token && probeSource) {
    const token = result.token
    const exit = await runtime.runPromiseExit(
      Effect.flatMap(VcsCredentials, (vcs) =>
        vcs.validateViaCli(opts.provider, opts.host, token, probeSource),
      ),
    )
    if (Exit.isSuccess(exit)) {
      await withVcs((vcs) => vcs.markTransportDegraded(opts.host, result.error ?? "tls"))
      return {
        ...result,
        outcome: "valid",
        user: exit.value.user,
        scopes: exit.value.scopes ?? result.scopes,
        validatedVia: "cli",
      }
    }
    // Any probe failure class degrades to the card — a broken probe never
    // masks the working remediation path.
  }

  return { ...result, coldReadOk }
}

/**
 * Map an orchestrated DetectionResult onto the per-channel IPC result shape
 * (found/valid plus the tri-state metadata). METADATA-ONLY: the raw
 * token never crosses — it is registered for redaction instead, and every
 * outbound error string passes through redactSecrets.
 */
export const toDetectionIpcResult = (result: OrchestratedDetection, host?: string) => {
  registerSecret(result.token)
  const common = {
    outcome: result.outcome,
    ...(result.source ? { source: result.source } : {}),
    ...(host ? { host } : {}),
  }
  switch (result.outcome) {
    case "absent":
      return {
        found: false as const,
        ...common,
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.error ? { error: redactSecrets(result.error) } : {}),
      }
    case "valid":
      return {
        found: true as const,
        valid: true as const,
        ...common,
        user: result.user,
        scopes: result.scopes,
        ...(result.envVar ? { envVar: result.envVar } : {}),
        ...(result.divergenceHint ? { divergenceHint: result.divergenceHint } : {}),
        ...(result.validatedVia ? { validatedVia: result.validatedVia } : {}),
      }
    case "invalid":
      return {
        found: true as const,
        valid: false as const,
        ...common,
        ...(result.warnings[0] ? { warning: result.warnings[0] } : {}),
        error: redactSecrets(result.error ?? result.warnings[0] ?? "invalid credentials"),
        status: result.status,
        ...(result.envVar ? { envVar: result.envVar } : {}),
      }
    case "unreachable":
      return {
        found: true as const,
        valid: false as const,
        ...common,
        errorKind: result.errorKind,
        ...(result.errorKind === "tls" ? { coldReadOk: result.coldReadOk ?? true } : {}),
        ...(result.error ? { error: redactSecrets(result.error) } : {}),
        status: result.status,
      }
  }
}

/**
 * toDetectionIpcResult for the validate channels, whose result shape carries
 * `valid` but no `found` (a validation always "found" its input token).
 */
export const toValidationIpcResult = (result: OrchestratedDetection, host?: string) => {
  const { found: _found, ...rest } = toDetectionIpcResult(result, host)
  return rest
}
