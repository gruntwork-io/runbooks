/**
 * Shared Effect runtime and singleton state for IPC handlers.
 *
 * The ManagedRuntime is created from AppLive, which provides all live service
 * implementations (FileSystem, ProcessSpawner, AwsClient, etc.). IPC handler
 * modules import the runtime to bridge async IPC calls into Effect programs.
 */
import { Effect, ManagedRuntime } from "effect"
import { AppLive } from "../../../src/layers/AppLayer.ts"
import { tryNormalizeGitHubHost } from "../../../src/domain/git/github-host.ts"
import { tryNormalizeGitLabHost } from "../../../src/domain/git/gitlab-host.ts"
import { SessionManager } from "../../../src/domain/session/manager.ts"
import type { SessionPersistence } from "../../../src/domain/session/persistence.ts"
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

/**
 * Starts and saves the session manager's sessions. Set once at startup, when
 * the userData directory is known (session-storage.ts).
 */
export let sessionPersistence: SessionPersistence | null = null

export function setSessionPersistence(persistence: SessionPersistence): void {
  sessionPersistence = persistence
}

/** Which git platform a token belongs to. The auth block establishes this. */
export type GitProvider = "github" | "gitlab"

/**
 * The token and host a block's `envFrom` gives for `provider`: from the
 * last block it names whose export has a token for that provider (a later
 * block wins), and only for the host that block signed in to.
 *
 * With `host`, the token is released only when the block's host is `host`,
 * so a clone URL, a repo's origin or a remote runbook URL can never carry it
 * to another host. Without it, the host is the block's own.
 */
export const exportedVcsCredential = (
  provider: GitProvider,
  envFrom: readonly string[],
  host?: string,
): { token: string; host: string } | undefined => {
  for (const id of [...envFrom].reverse()) {
    const env = sessionManager.getEnvExport(id)?.env
    if (env === undefined) continue
    const credential =
      provider === "github" ? githubExportCredential(env, host) : gitlabExportCredential(env, host)
    if (credential !== undefined) return credential
  }
  return undefined
}

function githubExportCredential(
  env: Readonly<Record<string, string>>,
  host: string | undefined,
): { token: string; host: string } | undefined {
  const blockHost = tryNormalizeGitHubHost(env.GITHUB_HOST)
  const token = env.GITHUB_TOKEN
  if (blockHost === undefined || !token) return undefined
  if (host !== undefined && tryNormalizeGitHubHost(host) !== blockHost) return undefined
  return { token, host: blockHost }
}

function gitlabExportCredential(
  env: Readonly<Record<string, string>>,
  host: string | undefined,
): { token: string; host: string } | undefined {
  const blockHost = tryNormalizeGitLabHost(env.GITLAB_HOST)
  const token = env.GITLAB_TOKEN
  if (blockHost === undefined || !token) return undefined
  if (host !== undefined && tryNormalizeGitLabHost(host) !== blockHost) return undefined
  return { token, host: blockHost }
}

/**
 * exportedVcsCredential as an Effect that fails with `onMissing()` when the
 * blocks `envFrom` names have no token for `provider` at `host`, so each
 * caller fails with the error type its pipeline expects.
 */
export const getExportedVcsCredential = <E>(
  provider: GitProvider,
  envFrom: readonly string[],
  host: string | undefined,
  onMissing: () => E,
) =>
  Effect.suspend(() => {
    const credential = exportedVcsCredential(provider, envFrom, host)
    return credential ? Effect.succeed(credential) : Effect.fail(onMissing())
  })

/**
 * The GitLab token `envFrom` gives for a request to `origin`, an instance
 * origin (`https://gitlab.example.com`): host-bound like
 * getExportedVcsCredential, and never over plain http. `origin` may come from
 * a runbook or a cloned repo's remote.
 */
export const getExportedGitLabTokenForOrigin = <E>(
  envFrom: readonly string[],
  origin: string,
  onMissing: () => E,
) =>
  Effect.gen(function* () {
    const url = URL.canParse(origin) ? new URL(origin) : undefined
    if (url?.protocol !== "https:") {
      return yield* Effect.fail(onMissing())
    }
    return (yield* getExportedVcsCredential("gitlab", envFrom, url.host, onMissing)).token
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
}

export function setRunbookConfig(config: RunbookConfig): void {
  runbookConfig = config
}

/** Global file manifest store for template block tracking. */
export const manifestStore: FileManifestStore = getManifestStore()
