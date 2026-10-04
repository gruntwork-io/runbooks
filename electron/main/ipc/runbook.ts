/**
 * IPC handlers for runbook operations.
 *
 * Provides runbook file reading, executable registry access, and reloading a
 * registered script file that changed on disk.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import * as fs from "fs"
import * as path from "path"
import {
  runtime,
  runbookConfig,
  executableRegistry,
  sessionManager,
  vcsSessionMeta,
  manifestStore,
  setExecutableRegistry,
  setRunbookConfig,
} from "./runtime.ts"
import { resetGoogleCredentialRegistry } from "./google-credential-registry.ts"
import { startWatcher, watchScripts } from "./watch.ts"
import { runbookAssetHost } from "./path-guard.ts"
import { ExecutableRegistry } from "../../../src/domain/registry/executable.ts"
import { protectedEnvVarsForRunbook } from "../../../src/domain/aws/protected-env.ts"
import { readFileMetadata, resolveRunbookPath } from "../../../src/domain/workspace/file.ts"
import { WarmRenderDispatcher } from "../../../src/services/WarmRenderDispatcher.ts"
import type { RunbookConfig } from "../../../src/types.ts"
import { resolveRemoteRunbook } from "../remote.ts"
import { getMainWindow } from "../window.ts"
import { makeLogger } from "../logger.ts"

const log = makeLogger("ipc:runbook")

/**
 * Build a clean, user-facing message for a failed runbook resolution.
 *
 * `resolveRunbookPath` fails with an Effect `FiberFailure` whose message leaks
 * internal stack detail — surfacing that verbatim in the renderer is the "ugly
 * error" we're replacing. This returns a short explanation the error screen can
 * show directly while offering a "choose another folder" retry.
 */
function describeRunbookOpenError(inputPath: string): string {
  try {
    if (fs.statSync(inputPath).isDirectory()) {
      return `This folder doesn't contain a runbook.mdx file:\n\n${inputPath}\n\nChoose a folder that contains a runbook.mdx file, or select a runbook file directly.`
    }
  } catch {
    return `This path no longer exists:\n\n${inputPath}`
  }
  return `This runbook couldn't be opened:\n\n${inputPath}`
}

/**
 * Bumped by every runbook:get. The renderer only shows its newest request
 * (useIpc drops older results), so a load that a newer one overtook while it
 * awaited ends as superseded instead of pointing the config, session, watcher
 * or registry back at its runbook.
 */
let loadGeneration = 0
const SUPERSEDED = { superseded: true } as const

/**
 * End every runbook:get still running as superseded, as a newer one would.
 * Closing the runbook calls this, so a load in flight at the close doesn't
 * start a watcher or set a registry for a runbook that is no longer open.
 */
export function supersedeRunbookLoads(): void {
  loadGeneration++
}

export function registerRunbookHandlers(): void {
  ipcMain.handle(
    "runbook:get",
    async (
      _event,
      params?: { path?: string; watchMode?: boolean; remoteSource?: string; reload?: "watch" },
    ) => {
      const generation = ++loadGeneration
      const superseded = () => generation !== loadGeneration

      // An empty path would resolve against the app's cwd below.
      if (!params?.path) {
        throw new Error("runbook path is required")
      }

      // Reject filesystem roots to prevent overly broad trust anchors
      const resolvedInput = path.resolve(params.path)
      if (resolvedInput === path.parse(resolvedInput).root) {
        throw new Error("runbook path must not be a filesystem root")
      }

      // Resolve the path — if it's a directory, look for runbook.mdx inside it.
      // Translate any resolution failure into a clean, user-facing message so
      // the renderer can show a friendly error (and a retry) instead of a raw
      // Effect FiberFailure dump.
      let runbookPath: string
      try {
        runbookPath = await runtime.runPromise(resolveRunbookPath(params.path))
      } catch (err) {
        log.debug("failed to resolve runbook path", params.path, err)
        throw new Error(describeRunbookOpenError(params.path), { cause: err })
      }
      if (superseded()) return SUPERSEDED
      const config: RunbookConfig = {
        localPath: runbookPath,
        ...(params.remoteSource !== undefined ? { remoteSourceURL: params.remoteSource } : {}),
        // The renderer doesn't send watchMode; keep what --watch set at launch.
        isWatchMode: params.watchMode ?? runbookConfig.isWatchMode,
        ...(runbookConfig.disableLiveFileReload !== undefined
          ? { disableLiveFileReload: runbookConfig.disableLiveFileReload }
          : {}),
      }
      setRunbookConfig(config)

      // The session's working dir is always the runbook's parent directory.
      // realpath'ing keeps macOS /var and /private/var paths aligned with
      // the rest of the pipeline (containment checks elsewhere realpath too).
      let sessionDir = path.dirname(runbookPath)
      try {
        sessionDir = fs.realpathSync(sessionDir)
      } catch {
        // Path may not exist yet — fall back to the lexical resolution.
      }

      // Read the runbook file content (before the session is created: whether
      // it has an <AwsAuth> block decides which env vars the session strips)
      const fileData = await runtime.runPromise(readFileMetadata(runbookPath))
      if (superseded()) return SUPERSEDED
      const isSameRunbook = sessionManager.getRunbookPath() === runbookPath

      // A different runbook than the one the current session belongs to
      // (including "no session yet") gets a fully fresh session: env,
      // working dir, AND registered/active git worktrees. Without this, a
      // worktree registered by a GitClone block in one runbook stays "active"
      // (session/manager.ts's getActiveWorkTreePath) after switching to an
      // unrelated runbook in the same running app, so REPO_FILES / worktree
      // templates resolve to a stale, possibly already-deleted, checkout.
      // Reloading the SAME runbook (watch mode, re-opening the same file)
      // must NOT do this — it would wipe env vars a script exported mid-run.
      if (!isSameRunbook) {
        // The previous runbook's executables must not stay runnable (or be
        // kept as this runbook's frozen registry below) if building this
        // runbook's registry fails. Cleared before the awaits, so a load of
        // this runbook that overtakes this one can't keep them either.
        setExecutableRegistry(null)
        watchScripts([])
        // A runbook with <AwsAuth> starts without the inherited AWS keys, so
        // no script sees them until the user confirms an account. Set on every
        // new session (even to []) so one runbook's list can't carry over.
        sessionManager.setProtectedEnvVars(protectedEnvVarsForRunbook(fileData.content))
        await runtime.runPromise(sessionManager.createSession(sessionDir, runbookPath))
        // These mirror the same "most recent wins across the whole process"
        // pattern as the worktree state above — reset them at the same
        // boundary so a Google credential or git-host auth banner from the
        // previous runbook can't leak into this one.
        resetGoogleCredentialRegistry()
        vcsSessionMeta.clear()
        // Template render state is keyed by the author-chosen Template id,
        // which the next runbook may reuse for a different template or
        // output dir. Drop the warm-render bundles, handles and vars
        // baselines, and the file manifests, so its first render starts clean.
        await runtime.runPromise(Effect.flatMap(WarmRenderDispatcher, (d) => d.reset))
        manifestStore.clear()
      } else if (params.reload !== "watch") {
        // Re-opening the runbook starts its blocks from its directory again.
        // A watch-mode reload keeps the session as it is, env vars included:
        // saving runbook.mdx must not undo a block's `cd`.
        sessionManager.setWorkingDir(sessionDir)
      }
      // The new session's resets await: a newer load may have started.
      if (superseded()) return SUPERSEDED

      // Watch mode: reload the renderer when this runbook changes. A no-op if
      // it's already watched; a watcher on a previous runbook is stopped.
      if (config.isWatchMode) {
        startWatcher(runbookPath)
      }

      // --disable-live-file-reload freezes the registry built when this
      // runbook was opened: reloading it (watch mode, re-opening the same
      // file) keeps executing the scripts that were approved then. Otherwise
      // build the executable registry from the runbook.
      let registry = isSameRunbook && config.disableLiveFileReload ? executableRegistry : null
      if (!registry) {
        const built = await runtime.runPromise(ExecutableRegistry.create(runbookPath))
        if (superseded()) return SUPERSEDED
        registry = built
        setExecutableRegistry(registry)

        // Notify the renderer that the registry has been rebuilt
        const win = getMainWindow()
        if (win) {
          win.webContents.send("registry:updated")
        }
      }

      // Watched with or without --watch, so a block can offer to reload a
      // script that changed on disk. A no-op when a reload of the runbook
      // leaves the same script files registered.
      watchScripts(registry.getScriptPaths())

      const ext = path.extname(runbookPath).replace(/^\./, "")

      return {
        path: runbookPath,
        content: fileData.content,
        contentHash: fileData.contentHash,
        language: ext || "mdx",
        size: fileData.content.length,
        isWatchMode: config.isWatchMode,
        warnings: registry.getWarnings(),
        remoteSource: params.remoteSource,
        assetHost: runbookAssetHost(config),
      }
    },
  )

  // Clones and resolves the runbook, but leaves opening it to the renderer:
  // the Open from URL modal only opens the result if the user hasn't cancelled
  // while the clone was running.
  ipcMain.handle("runbook:open-remote", async (_event, params: { url: string }) => {
    const result = await resolveRemoteRunbook(params.url)
    return { path: result.localPath, remoteSource: result.remoteSource }
  })

  ipcMain.handle("runbook:executables", async () => {
    if (!executableRegistry) {
      return { executables: {}, warnings: [] }
    }

    return {
      executables: executableRegistry.getAllExecutables(),
      warnings: executableRegistry.getWarnings(),
    }
  })

  ipcMain.handle("runbook:script-change", async (_event, params: { componentId: string }) => {
    if (!executableRegistry) {
      return { change: null }
    }

    return {
      change: await runtime.runPromise(executableRegistry.getScriptFileChange(params.componentId)),
    }
  })

  // The renderer names the block and the hash of the content the user
  // reviewed, never a path or script content: main re-reads the file the
  // registry entry was built from and registers it only if it has that hash.
  ipcMain.handle(
    "runbook:reload-script",
    async (_event, params: { componentId: string; contentHash: string }) => {
      if (!executableRegistry) {
        throw new Error("No runbook loaded")
      }

      await runtime.runPromise(
        executableRegistry.reloadFileEntry(params.componentId, params.contentHash),
      )

      // The entry has a new ID: the renderer re-reads the registry to run it.
      getMainWindow()?.webContents.send("registry:updated")
      return { ok: true as const }
    },
  )
}
