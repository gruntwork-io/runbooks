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
import { githubSessionCredential } from "../../../src/domain/github/auth.ts"
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
 * Resolve the GitHub session credential for `host` (undefined = the
 * session's GitHub host), HOST-BOUND: a token is released only for the host
 * it belongs to (githubSessionCredential), so a github.com token never
 * reaches an enterprise host or the reverse. Yields the token and the host it
 * belongs to, so API calls target that host.
 */
export const getGitHubSessionCredential = <E>(host: string | undefined, onMissing: () => E) =>
  Effect.gen(function* () {
    const session = yield* sessionManager.getSession()
    const credential = githubSessionCredential(
      Object.fromEntries(session.env),
      host,
      vcsSessionMeta.get("github")?.host,
    )
    if (!credential) {
      return yield* Effect.fail(onMissing())
    }
    return credential
  })

/**
 * Resolve an auth token for a git PROVIDER from the current session's
 * environment.
 *
 * Tokens are populated by the GitAuth block (github:* / gitlab:* handlers via
 * session:set-env) and are the single source of truth for "which token do git
 * and API calls use" — the renderer never holds them directly. The PROVIDER —
 * NOT the remote hostname — selects which env var to read:
 *   - github -> the session's GitHub host credential (GITHUB_TOKEN, then
 *     GH_TOKEN, or GH_ENTERPRISE_TOKEN for a GHES GH_HOST — see
 *     getGitHubSessionCredential)
 *   - gitlab -> GITLAB_TOKEN
 *
 * Keying on the provider (rather than parsing the remote host) is what makes
 * self-hosted GitLab work: those instances live on arbitrary hostnames, so
 * the host tells us nothing about which credential to use — the linked auth
 * block does. Callers that send the token to a host they know (a clone URL,
 * a repo's origin) should use getSessionTokenForHost instead. Callers supply
 * `onMissing` so each can fail with the error type its pipeline expects (a
 * typed GitError for git handlers, a plain Error for API handlers).
 */
export const getSessionTokenForProvider = <E>(provider: GitProvider, onMissing: () => E) =>
  Effect.gen(function* () {
    if (provider === "github") {
      return (yield* getGitHubSessionCredential(undefined, onMissing)).token
    }
    const session = yield* sessionManager.getSession()
    const token = session.env.get("GITLAB_TOKEN")
    if (!token) {
      return yield* Effect.fail(onMissing())
    }
    return token
  })

/**
 * Host-bound variant of getSessionTokenForProvider for callers that send the
 * token to a specific host (a clone URL, a repo's origin — possibly from
 * UNTRUSTED input like a remote runbook URL): the session credential is
 * released only for the host the auth block established it for (binding —
 * the GitHub session host, or the GITLAB_HOST written alongside the token).
 */
export const getSessionTokenForHost = <E>(
  provider: GitProvider,
  host: string,
  onMissing: () => E,
) =>
  Effect.gen(function* () {
    if (provider === "github") {
      return (yield* getGitHubSessionCredential(host, onMissing)).token
    }
    const session = yield* sessionManager.getSession()
    const boundHost = (session.env.get("GITLAB_HOST") ?? DEFAULT_GITLAB_HOST).toLowerCase()
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
