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
  sessionPersistence,
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
import type { SessionNotFoundError } from "../../../src/errors/index.ts"
import { registerSecret, VCS_TOKEN_ENV_VARS } from "../../../src/domain/vcs/redact.ts"
import type { OpenRunbookPayload } from "../open-runbook.ts"
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

let sessionTurns: Promise<unknown> = Promise.resolve()

/**
 * Run `switchSession` after every session switch requested before it has
 * finished. Starting a session reads the file system, so two loads could
 * otherwise switch at once, and the older one finishing last would leave the
 * renderer showing one runbook over another runbook's session.
 */
function inSessionTurn<A>(switchSession: () => Promise<A>): Promise<A> {
  const turn = sessionTurns.then(switchSession)
  sessionTurns = turn.catch(() => {})
  return turn
}

/** The runbook the renderer shows, as the last runbook:get loaded it. */
let openRunbook: OpenRunbookPayload | null = null

/**
 * Record that the runbook was closed, and end every runbook:get still running
 * as superseded, as a newer one would: a load in flight at the close must not
 * start a watcher or set a registry for a runbook that is no longer open.
 */
export function markRunbookClosed(): void {
  loadGeneration++
  openRunbook = null
}

/** How the command line asked for a runbook, kept for the runbook:get that loads it. */
export interface Launch {
  /** The `path`, or for a remote runbook the `remoteSource`, that the renderer will ask runbook:get for. */
  source: string
  /** The directory `runbooks` was run from, or undefined when the launch has none (the dock, a file manager). */
  launchDir: string | undefined
  /** The session to resume, when the launch named no runbook and one was found for it. */
  sessionId: string | undefined
}

let pendingLaunch: Launch | null = null

/** Tell the next runbook:get for `launch.source` how it was launched. */
export function expectLaunch(launch: Launch): void {
  pendingLaunch = launch
}

/** The open runbook's path while File > Reset Session waits for its reload. */
let newSessionFor: string | null = null

/**
 * File > Reset Session: replace the open runbook's session with a new one.
 * Its blocks start over in a new, empty session directory, under a new name,
 * with the environment the app was launched with. The session it replaces
 * stays on disk, and only a switch to it (session:switch) opens it again.
 * Does nothing while no runbook is open.
 */
export function resetToNewSession(): void {
  const win = getMainWindow()
  if (!win || openRunbook === null) return
  newSessionFor = openRunbook.path
  win.webContents.send("file:open-runbook", openRunbook)
}

/** Whether the renderer is showing the session with this id. */
export function isSessionOpen(id: string): boolean {
  return openRunbook !== null && sessionPersistence?.currentSession()?.id === id
}

/**
 * Session tokens for log redaction. A resumed session has the tokens its auth
 * blocks set in an earlier run, which nothing registered in this one.
 */
function registerSessionSecrets(): Effect.Effect<void, SessionNotFoundError> {
  return Effect.map(sessionManager.getSession(), (session) => {
    for (const tokenVar of VCS_TOKEN_ENV_VARS) {
      registerSecret(session.env.get(tokenVar))
    }
  })
}

export function registerRunbookHandlers(): void {
  ipcMain.handle(
    "runbook:get",
    async (_event, params?: { path?: string; watchMode?: boolean; remoteSource?: string }) => {
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

      // Read the runbook file content (before the session is created: whether
      // it has an <AwsAuth> block decides which env vars the session strips)
      const fileData = await runtime.runPromise(readFileMetadata(runbookPath))
      if (superseded()) return SUPERSEDED

      // index.ts sets this at startup, before any window can call a handler.
      const persistence = sessionPersistence
      if (!persistence) throw new Error("session persistence is not initialized")

      const launch =
        pendingLaunch?.source === (params.remoteSource ?? params.path) ? pendingLaunch : null

      const turn = await inSessionTurn(async () => {
        // A newer load took this one's place while it waited for its turn.
        if (superseded()) return SUPERSEDED
        const sameRunbook = sessionManager.getRunbookPath() === runbookPath
        const startNew = newSessionFor === runbookPath
        const resumesOtherSession =
          launch?.sessionId !== undefined && launch.sessionId !== persistence.currentSession()?.id

        // A different runbook than the one the live session belongs to
        // (including "no session yet") replaces the session, with the one
        // saved for this runbook or a new one: env, working dir, AND
        // registered/active git worktrees. Without this, a worktree registered
        // by a GitClone block in one runbook stays "active"
        // (session/manager.ts's getActiveWorkTreePath) after switching to an
        // unrelated runbook in the same running app, so REPO_FILES / worktree
        // templates resolve to another runbook's checkout. So does File >
        // Reset Session, and a launch that resumes another of this runbook's
        // sessions.
        // Reloading the SAME runbook (watch mode, re-opening the same file)
        // must NOT do this — it would wipe env vars a script exported mid-run.
        // It keeps the session as it is, working dir included, as the blocks
        // resume from the session's history.
        const switched = !sameRunbook || startNew || resumesOtherSession
        if (switched) {
          // The previous runbook's executables must not stay runnable (or be
          // kept as this runbook's frozen registry below) if building this
          // runbook's registry fails. Cleared before the session starts, so a
          // load of this runbook that overtakes this one, and takes its turn
          // after it, can't keep them either.
          if (!sameRunbook) {
            setExecutableRegistry(null)
            watchScripts([])
          }
          // A runbook with <AwsAuth> starts without the inherited AWS keys, so
          // no script sees them until the user confirms an account. Set on
          // every new session (even to []) so one runbook's list can't carry
          // over.
          sessionManager.setProtectedEnvVars(protectedEnvVarsForRunbook(fileData.content))
          await runtime.runPromise(
            Effect.andThen(
              persistence.open({
                runbook: { path: runbookPath, remoteSource: params.remoteSource },
                launchDir: launch?.launchDir,
                sessionId: launch?.sessionId,
                startNew,
              }),
              registerSessionSecrets(),
            ),
          )
          if (launch) pendingLaunch = null
          if (startNew) newSessionFor = null
        }
        return { sameRunbook, switched }
      })
      if ("superseded" in turn) return turn
      const isSameRunbook = turn.sameRunbook

      if (turn.switched) {
        // These mirror the same "most recent wins across the whole process"
        // pattern as the worktree state above — reset them at the same
        // boundary so a Google credential or git-host auth banner from the
        // previous runbook can't leak into this one.
        resetGoogleCredentialRegistry()
        vcsSessionMeta.clear()
        // A resumed session's git credentials stay bound to the hosts they
        // were bound to: the env's GITHUB_HOST and GH_HOST alone would let a
        // GitHub Enterprise token go to github.com.
        const bindings = persistence.currentSession()?.vcsBindings ?? {}
        for (const provider of ["github", "gitlab"] as const) {
          const binding = bindings[provider]
          if (binding) vcsSessionMeta.set(provider, binding)
        }
        // Template render state is keyed by the author-chosen Template id,
        // which the next runbook may reuse for a different template or
        // output dir. Drop the warm-render bundles, handles and vars
        // baselines, and the file manifests, so its first render starts clean.
        await runtime.runPromise(Effect.flatMap(WarmRenderDispatcher, (d) => d.reset))
        manifestStore.clear()
      } else if (launch) {
        // `runbooks <this runbook>` run again, perhaps from another directory.
        await runtime.runPromise(persistence.recordLaunch(runbookPath, launch.launchDir))
        pendingLaunch = null
      }
      // The new session's resets await: a newer load may have started.
      if (superseded()) return SUPERSEDED

      const session = persistence.currentSession()
      if (session === undefined) throw new Error("the open runbook has no saved session")

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

      // Read on every load, not only when the session starts: the renderer
      // remounts its blocks when the same runbook is opened again after a
      // close, and they resume from the history as it is now. A history that
      // can't be read leaves the blocks to start over: the runbook still opens.
      const blockStates = await runtime.runPromise(
        persistence.blockStates().pipe(
          Effect.catchAll((err) => {
            log.warn("failed to read the session's history:", err.message)
            return Effect.succeed([])
          }),
        ),
      )
      if (superseded()) return SUPERSEDED

      // Watched with or without --watch, so a block can offer to reload a
      // script that changed on disk. A no-op when a reload of the runbook
      // leaves the same script files registered.
      watchScripts(registry.getScriptPaths())

      const ext = path.extname(runbookPath).replace(/^\./, "")

      openRunbook = {
        path: runbookPath,
        ...(params.remoteSource !== undefined ? { remoteSource: params.remoteSource } : {}),
      }

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
        sessionId: session.id,
        sessionName: session.name,
        sessionDir: session.dir,
        blockStates,
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
