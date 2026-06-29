/**
 * Shared Effect runtime and singleton state for IPC handlers.
 *
 * The ManagedRuntime is created from AppLive, which provides all live service
 * implementations (FileSystem, ProcessSpawner, AwsClient, etc.). IPC handler
 * modules import the runtime to bridge async IPC calls into Effect programs.
 */
import { Effect, ManagedRuntime } from "effect"
import { AppLive } from "../../../src/layers/AppLayer.ts"
import { DEFAULT_GITLAB_HOST } from "../../../src/domain/gitlab/auth.ts"
import { SessionManager } from "../../../src/domain/session/manager.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { FileManifestStore, getManifestStore } from "../../../src/domain/files/manifest.ts"
import type { RunbookConfig } from "../../../src/types.ts"

// ---------------------------------------------------------------------------
// Effect runtime backed by the full application layer
// ---------------------------------------------------------------------------

export const runtime = ManagedRuntime.make(AppLive)

// ---------------------------------------------------------------------------
// Shared singleton state accessed by IPC handlers
// ---------------------------------------------------------------------------

/** Singleton session manager -- one session per app instance. */
export const sessionManager = new SessionManager()

/** Which git platform a token belongs to. The auth block establishes this. */
export type GitProvider = "github" | "gitlab"

/**
 * Main-only provenance metadata for the current session credential:
 * which host and source the
 * provider's session token came from. Drives the stale-session warning (a
 * second GitLab block replacing the single GITLAB_TOKEN/GITLAB_HOST pair)
 * and support diagnostics. Never holds tokens.
 */
export const vcsSessionMeta = new Map<GitProvider, { host: string; source?: string }>()

/**
 * Resolve an auth token for a git PROVIDER from the current session's
 * environment.
 *
 * Tokens are populated by the GitAuth block (github:* / gitlab:* handlers via
 * session:set-env) and are the single source of truth for "which token do git
 * and API calls use" — the renderer never holds them directly. The PROVIDER —
 * NOT the remote hostname — selects which env var to read:
 *   - github -> GITHUB_TOKEN, then GH_TOKEN
 *   - gitlab -> GITLAB_TOKEN
 *
 * Keying on the provider (rather than parsing the remote host) is what makes
 * self-hosted GitHub/GitLab work: those instances live on arbitrary hostnames,
 * so the host tells us nothing about which credential to use — the linked auth
 * block does. Callers supply `onMissing` so each can fail with the error type
 * its pipeline expects (a typed GitError for git handlers, a plain Error for
 * API handlers).
 */
export const getSessionTokenForProvider = <E>(provider: GitProvider, onMissing: () => E) =>
  Effect.gen(function* () {
    const session = yield* sessionManager.getSession()
    const token =
      provider === "gitlab"
        ? session.env.get("GITLAB_TOKEN")
        : session.env.get("GITHUB_TOKEN") ?? session.env.get("GH_TOKEN")
    if (!token) {
      return yield* Effect.fail(onMissing())
    }
    return token
  })

/**
 * Resolve the GitHub token from the current session's environment. Thin
 * GitHub-pinned wrapper over getSessionTokenForProvider for existing callers
 * (e.g. github:* API handlers and the pull-request flow, which are GitHub-only).
 */
export const getSessionToken = <E>(onMissing: () => E) =>
  getSessionTokenForProvider("github", onMissing)

/**
 * Host-bound variant of getSessionTokenForProvider for callers whose target
 * host comes from UNTRUSTED input (a remote runbook URL): the session
 * credential is released only for the host the auth block established it for
 * (binding — github.com, or the GITLAB_HOST written alongside the token).
 */
export const getSessionTokenForHost = <E>(
  provider: GitProvider,
  host: string,
  onMissing: () => E,
) =>
  Effect.gen(function* () {
    const session = yield* sessionManager.getSession()
    const boundHost =
      provider === "gitlab"
        ? (session.env.get("GITLAB_HOST") ?? DEFAULT_GITLAB_HOST).toLowerCase()
        : "github.com"
    if (host.trim().toLowerCase() !== boundHost) {
      return yield* Effect.fail(onMissing())
    }
    return yield* getSessionTokenForProvider(provider, onMissing)
  })

/** Executable registry -- populated when a runbook is loaded. */
export let executableRegistry: ExecutableRegistry | null = null

export function setExecutableRegistry(reg: ExecutableRegistry | null): void {
  executableRegistry = reg
}

/** Current runbook configuration. */
export let runbookConfig: RunbookConfig = {
  localPath: "",
  isWatchMode: false,
  useExecutableRegistry: true,
}

export function setRunbookConfig(config: RunbookConfig): void {
  runbookConfig = config
}

/** Global file manifest store for template block tracking. */
export const manifestStore: FileManifestStore = getManifestStore()
