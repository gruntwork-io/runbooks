/**
 * Shared Effect runtime and singleton state for IPC handlers.
 *
 * The ManagedRuntime is created from AppLive, which provides all live service
 * implementations (FileSystem, ProcessSpawner, AwsClient, etc.). IPC handler
 * modules import the runtime to bridge async IPC calls into Effect programs.
 */
import { Effect, ManagedRuntime } from "effect"
import { AppLive } from "../../../src/layers/AppLayer.ts"
import { SessionManager } from "../../../src/domain/session/manager.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { FileManifestStore, getManifestStore } from "../../../src/domain/files/manifest.ts"
import type { RunbookConfig } from "../../../src/types.ts"
import type { Stream } from "effect"
import type { FileChangeEvent } from "../../../src/services/FileSystem.ts"
import type { FileWatchError } from "../../../src/errors/index.ts"

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
 * Resolve an auth token for a git host from the current session's environment.
 *
 * Tokens are populated by the GitAuth block (github:* / gitlab:* handlers via
 * session:set-env) and are the single source of truth for "which token do git
 * and API calls use" — the renderer never holds them directly. The host
 * selects which env var to read:
 *   - github.com -> GITHUB_TOKEN, then GH_TOKEN
 *   - gitlab.com -> GITLAB_TOKEN
 * Callers supply `onMissing` so each can fail with the error type its pipeline
 * expects (e.g. a typed GitError for git handlers, a plain Error for API
 * handlers).
 */
export const getSessionTokenForHost = <E>(host: string, onMissing: () => E) =>
  Effect.gen(function* () {
    const session = yield* sessionManager.getSession()
    let token: string | undefined
    if (host === "gitlab.com") {
      token = session.env.get("GITLAB_TOKEN")
    } else {
      token = session.env.get("GITHUB_TOKEN") ?? session.env.get("GH_TOKEN")
    }
    if (!token) {
      return yield* Effect.fail(onMissing())
    }
    return token
  })

/**
 * Resolve the GitHub token from the current session's environment. Thin
 * GitHub-pinned wrapper over getSessionTokenForHost for existing callers (e.g.
 * github:* API handlers and the pull-request flow, which are GitHub-only).
 */
export const getSessionToken = <E>(onMissing: () => E) =>
  getSessionTokenForHost("github.com", onMissing)

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

/** Active file watcher stream -- non-null when watch mode is active. */
export let fileWatcher: Stream.Stream<FileChangeEvent, FileWatchError> | null = null

export function setFileWatcher(
  watcher: Stream.Stream<FileChangeEvent, FileWatchError> | null,
): void {
  fileWatcher = watcher
}

/** Global file manifest store for template block tracking. */
export const manifestStore: FileManifestStore = getManifestStore()
