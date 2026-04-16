/**
 * Shared Effect runtime and singleton state for IPC handlers.
 *
 * The ManagedRuntime is created from AppLive, which provides all live service
 * implementations (FileSystem, ProcessSpawner, AwsClient, etc.). IPC handler
 * modules import the runtime to bridge async IPC calls into Effect programs.
 */
import { ManagedRuntime } from "effect"
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

/**
 * Working directory explicitly supplied on the command line via --working-dir.
 * When set, it pins the session's workingDir and prevents the runbook loader
 * from overriding it with the runbook's parent directory. Used by E2E tests
 * to isolate generated files in a temp dir.
 */
export let cliWorkingDir: string | null = null

export function setCliWorkingDir(dir: string | null): void {
  cliWorkingDir = dir
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
