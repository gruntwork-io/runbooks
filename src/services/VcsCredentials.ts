/**
 * VcsCredentials — the single credential resolver.
 *
 * One service unifies what used to be two resolvers (the GitAuth IPC
 * detection flows in src/domain/{github,gitlab}/auth.ts and the weaker
 * remote-source getTokenForHost): per-source detection legs with direct
 * validation, the read-only host→token resolution, the
 * validation-only CLI fallback probe, CLI diagnostics, and the caches.
 *
 * Tri-state ORCHESTRATION (cold trust-refresh-and-retry on tls, probe
 * routing, session writes) deliberately lives in the IPC handlers — the
 * refresh needs the Electron-side cold-read child, and this service must stay
 * Bun-test-safe.
 */
import { Context, Effect } from "effect"
import type { VcsCliError, VcsTransportErrorKind } from "../errors/index.ts"
import type { CliStatus } from "../domain/vcs/cli-status.ts"

export type VcsProvider = "github" | "gitlab"

export interface VcsUserInfo {
  readonly login: string
  readonly name?: string
  readonly avatarUrl?: string
  readonly email?: string
}

/** Where a detected credential came from. "manual" = user-pasted PAT. */
export type VcsCredentialSource = "env" | "cli" | "config" | "manual"

/**
 * Tri-state detection result. `token` stays main-side.
 */
export interface DetectionResult {
  readonly outcome: "valid" | "invalid" | "unreachable" | "absent"
  readonly token?: string
  readonly source?: "env" | "cli" | "config"
  readonly user?: VcsUserInfo
  readonly scopes?: string[]
  readonly warnings: string[]
  readonly errorKind?: VcsTransportErrorKind
  /** HTTP status of a failed validation (renderer distinguishes 401/403). */
  readonly status?: number
  /** Raw failure message (sanitized before crossing IPC). */
  readonly error?: string
  /** The env var the token came from (env source). */
  readonly envVar?: string
  /** both-set-and-differ visibility hint (env source). */
  readonly divergenceHint?: string
  /** Manual-UI hint copy (the keyring contracts). */
  readonly hint?: string
  /** How the accepted token was validated — "cli" marks degraded auth. */
  readonly validatedVia?: "direct" | "cli"
}

/** Successful probe result. */
export interface CliValidation {
  readonly user: VcsUserInfo
  readonly scopes?: string[]
}

export interface VcsCliStatusInfo {
  readonly gh: CliStatus
  readonly glab: CliStatus
  readonly git?: { readonly sslBackend?: string }
}

/** Step 5 widens this to the annotated union (provenance + hasCredential). */
export interface MergedGitLabHosts {
  readonly hosts: string[]
  readonly defaultHost: string
}

export interface VcsCredentialsShape {
  // --- Per-source detection legs (validated direct-fetch; used by the
  //     GitAuth IPC handlers, which orchestrate tri-state on top) -----------
  // The GitLab `instance` parameters take the instance origin
  // (normalizeGitLabBaseUrl output — a manually-entered `http://` scheme must
  // survive through validation); the legs derive the bare host internally for
  // glab/config reads. A bare host normalizes to its https origin.
  readonly detectGitHubEnv: (prefix?: string) => Effect.Effect<DetectionResult>
  readonly detectGitHubCli: () => Effect.Effect<DetectionResult>
  readonly detectGitLabEnv: (instance: string) => Effect.Effect<DetectionResult>
  readonly detectGitLabCli: (instance: string) => Effect.Effect<DetectionResult>

  // --- full chains: first-success-wins; `invalid` warns and continues;
  //     `unreachable` stops without consuming later sources -----------------
  readonly resolveGitHub: (prefix?: string) => Effect.Effect<DetectionResult>
  readonly resolveGitLab: (instance: string) => Effect.Effect<DetectionResult>

  /** Direct (one-transport) validation of an arbitrary token — the PAT path.
   *  Tri-state outcome; no source (the caller knows it's manual). */
  readonly validateDirect: (
    provider: VcsProvider,
    host: string,
    token: string,
  ) => Effect.Effect<DetectionResult>

  /**
   * unified host→token resolution (replaces remote-source
   * getTokenForHost). READ-ONLY: source reads with no network validation
   * (golang semantics — an absent result is silent fall-through and an empty
   * final result is NOT an error; the repo may be public). Session-env
   * precedence is composed by the caller (it lives Electron-side).
   */
  readonly tokenForHost: (host: string) => Effect.Effect<string | undefined>

  readonly enumerateGitLabHosts: () => Effect.Effect<MergedGitLabHosts>

  /**
   * validation-only CLI fallback probe — narrow and deterministic:
   * gh api user -i / glab api user (candidate token via CHILD ENV, never
   * argv) for PAT-shaped tokens; glab auth status (no token injection) for
   * glab-sourced OAuth-shaped tokens. Every failure class is a typed
   * VcsCliError: the caller degrades to the TLS/network card, never blocks.
   */
  readonly validateViaCli: (
    provider: VcsProvider,
    host: string,
    token: string,
    source: VcsCredentialSource,
  ) => Effect.Effect<CliValidation, VcsCliError>

  readonly cliStatus: () => Effect.Effect<VcsCliStatusInfo>

  /** Flush the per-(binary,host) CLI read cache + the cliStatus probe cache
   *  (invalidation: auth failures and renderer-initiated re-detection). */
  readonly invalidateCache: () => Effect.Effect<void>

  // --- transport-degraded host bookkeeping ----------------------------
  /** Records the degraded host + emits the structured field-canary log line. */
  readonly markTransportDegraded: (host: string, code: string) => Effect.Effect<void>
  readonly isTransportDegraded: (host: string) => Effect.Effect<boolean>
  /** Cleared by HostSelect Reload. */
  readonly clearTransportDegraded: () => Effect.Effect<void>
}

export class VcsCredentials extends Context.Tag("VcsCredentials")<VcsCredentials, VcsCredentialsShape>() {}
