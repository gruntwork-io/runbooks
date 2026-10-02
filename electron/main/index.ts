// Suppress the CSP security warning in development — Vite's HMR requires
// inline scripts which are incompatible with a strict CSP. The production
// build sets a proper CSP via session.webRequest headers.
if (process.env.ELECTRON_RENDERER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"
}

import { app, shell, ipcMain, dialog, protocol, net, nativeTheme, session } from "electron"
import type { BrowserWindow } from "electron"
import * as path from "path"
import * as fs from "fs"
import { pathToFileURL } from "node:url"
import { createMainWindow, focusOrCreateWindow, getMainWindow, setTitleBarTheme } from "./window.ts"
import { openRunbookInWindow, openRemoteRunbookInWindow } from "./open-runbook.ts"
import { getStoredTheme } from "./theme-store.ts"
import { setupApplicationMenu } from "./menu.ts"
import { initAutoUpdater } from "./updater.ts"
import { parseCliArgs, secondInstanceArgv } from "./cli.ts"
import { requestLaunchLock, secondInstanceLaunchDirectory } from "./launch-dir.ts"
import { registerAllIpcHandlers } from "./ipc/index.ts"
import { checkCliInstall, installCli } from "./cli-install.ts"
import { runtime, setRunbookConfig, runbookConfig } from "./ipc/runtime.ts"
import { closeRunbook, stopWatcher } from "./ipc/watch.ts"
import { resolveRemoteRunbook, cleanupTempClones } from "./remote.ts"
import { cleanupGoogleCredentialFiles } from "./ipc/google-credentials.ts"
import { cancelAllExecutions } from "./ipc/exec.ts"
import { resolveRunbookAssetPath, runbookAssetHost } from "./ipc/path-guard.ts"
import { byteRangeResponse } from "./asset-range.ts"
import { installClientCertificateHandler, installPermissionHandlers } from "./permissions.ts"
import {
  LOCAL_EMBED_PARTITION,
  WEB_EMBED_PARTITION,
  hardenEmbedGuest,
  installEmbedSession,
  prepareWebviewAttach,
} from "./embeds.ts"
import { getContentType } from "../../src/domain/workspace/file.ts"
import { makeLogger } from "./logger.ts"
import { populateShellEnv } from "./shell-env.ts"
import { initSystemTrust } from "./system-trust.ts"
import { eagerLoadInBackground as eagerLoadBoilerplateWasm } from "../../src/layers/NodeWasmRuntime.ts"
import { registerSecret, VCS_TOKEN_ENV_VARS } from "../../src/domain/vcs/redact.ts"
import { init as initTelemetry, shutdown as shutdownTelemetry } from "../../src/telemetry.ts"

const log = makeLogger("main")

// Test seam: redirect userData so e2e runs never touch the real profile
// (recent-hosts persistence assertions need an isolated, restart-stable dir).
if (process.env.RUNBOOKS_TEST_USER_DATA_DIR) {
  app.setPath("userData", process.env.RUNBOOKS_TEST_USER_DATA_DIR)
}

// Pre-populate process.env from the user's login shell so that PATH and
// other profile-driven vars are visible to scripts we spawn. Must run
// before SessionManager captures process.env on first runbook load.
populateShellEnv()

// Register ambient token values for log/IPC redaction: the exact-match
// scrub is the only safe way to catch GitLab's unprefixed 64-hex OAuth tokens.
for (const tokenVar of VCS_TOKEN_ENV_VARS) {
  registerSecret(process.env[tokenVar])
}

// ---------------------------------------------------------------------------
// System-trust TLS: honor the OS trust store in addition to Node's bundled
// roots (see system-trust.ts). Must run before any TLS connection.
// ---------------------------------------------------------------------------

initSystemTrust()

// Point the boilerplate renderer at the vendored CLI + WASM artifacts the
// `just fetch-boilerplate` recipe drops under resources/. In packaged
// builds, electron-builder.extraResources puts them next to app.asar; in
// dev (`electron-vite dev`), resources/ sits at the repo root.
//
// Always the vendored copy, unconditionally: a `boilerplate` on the user's
// PATH or a stale BOILERPLATE_BIN exported from their shell rc (which
// populateShellEnv() has already merged in above) must never be picked up.
// The CLI and WASM blob are pinned to the same release in the justfile, and
// a version skew between them silently changes how templates render.
//
// The one escape hatch is RUNBOOKS_BOILERPLATE_BIN / RUNBOOKS_BOILERPLATE_WASM_DIR
// for testing a custom boilerplate build. The names are deliberately
// different from the BOILERPLATE_* vars the render layers read: nobody has
// RUNBOOKS_BOILERPLATE_BIN set by accident, so it stays an explicit choice.
{
  // Packaged: extraResources lands files under process.resourcesPath
  // (e.g. .app/Contents/Resources/bin, .../wasm). Dev (electron <main.js>
  // or electron-vite dev): __dirname is <repo>/dist/main, so resources/
  // sits two levels up. electron-vite shims __dirname for ESM builds.
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..", "..", "resources")
  const vendoredBin = path.join(
    resourcesDir,
    "bin",
    process.platform === "win32" ? "boilerplate.exe" : "boilerplate",
  )
  const vendoredWasmDir = path.join(resourcesDir, "wasm")

  const overrideBin = process.env.RUNBOOKS_BOILERPLATE_BIN
  const overrideWasmDir = process.env.RUNBOOKS_BOILERPLATE_WASM_DIR
  const bin = overrideBin || vendoredBin
  const wasmDir = overrideWasmDir || vendoredWasmDir
  process.env.BOILERPLATE_BIN = bin
  process.env.BOILERPLATE_WASM_DIR = wasmDir

  // Never silent: an override changes what every template renders with.
  if (overrideBin) log.warn(`RUNBOOKS_BOILERPLATE_BIN override active: ${overrideBin}`)
  if (overrideWasmDir) log.warn(`RUNBOOKS_BOILERPLATE_WASM_DIR override active: ${overrideWasmDir}`)

  // Missing artifacts mean a broken checkout, package, or override — not a
  // reason to go hunting on PATH. Say so loudly; the render layers will fail
  // with the same path in their error so the cause is obvious.
  const missing = [
    bin,
    path.join(wasmDir, "boilerplate-full.wasm.br"),
    path.join(wasmDir, "wasm_exec.js"),
  ].filter((f) => !fs.existsSync(f))
  if (missing.length > 0) {
    const hint =
      overrideBin || overrideWasmDir
        ? "Check the RUNBOOKS_BOILERPLATE_* override paths."
        : "Run `just fetch-boilerplate`."
    log.error(
      `Boilerplate artifacts missing (${missing.join(", ")}); template rendering will fail. ${hint}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Register the runbook-asset protocol as privileged so it can be used in img
// src, video src, etc. Must be called before app.whenReady().
//
// <video>/<audio> can seek only with `standard: true` and the handler's Range
// support (asset-range.ts); electron/e2e/runbook-assets.spec.ts loads and
// seeks both.
// - `standard: true`: a seek past what the first response delivered makes
//   Chromium's media loader send a second range request, and for a
//   non-standard scheme it fails that response and playback stops with
//   PIPELINE_ERROR_READ "data source error". The URL then parses with host
//   `assets`, which resolveRunbookAssetPath joins back onto the path.
// - `stream: true` is the privilege Electron documents for streaming media:
//   without it Chromium treats the resource as already fully buffered. Before
//   the handler answered Range requests, that made media elements fail its
//   streamed body with MEDIA_ELEMENT_ERROR "Format error" (a 520 KB WAV and a
//   65 MB MP4 did; a 446 KB faststart MP4 still played).
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: "runbook-asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

// ---------------------------------------------------------------------------
// Single instance lock — focus existing window instead of opening a second.
// ---------------------------------------------------------------------------

// requestLaunchLock first makes the cwd readable: when `runbooks` is run from
// a folder that has been deleted, process.cwd() throws and Chromium's hand-off
// to the running app fails (see launch-dir.ts). launchDir is what relative CLI
// paths resolve against.
//
// A second instance sends its unmodified argv along: the `argv` Electron
// hands to "second-instance" has been reordered by Chromium (see
// secondInstanceArgv). It sends launchDir too: after a recovery, Electron's
// `workingDirectory` is the folder it moved to, not the one it was run from.
const { gotLock, launchDir } = requestLaunchLock(
  (data) => app.requestSingleInstanceLock(data),
  process.argv,
)

if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv, workingDirectory, additionalData) => {
    const win = focusOrCreateWindow()
    // Resolve relative paths against the directory the second instance was
    // launched from, not this (first) instance's cwd.
    const secondArgs = parseCliArgs(
      secondInstanceArgv(argv, additionalData),
      secondInstanceLaunchDirectory(workingDirectory, additionalData),
      app.getAppPath(),
    )
    if (secondArgs.remoteUrl) {
      openRemoteRunbook(win, secondArgs.remoteUrl)
    } else if (secondArgs.runbookPath) {
      // focusOrCreateWindow may return a window that is still loading.
      openRunbookInWindow(win, { path: secondArgs.runbookPath })
    }
  })
}

/**
 * Clone and open a remote runbook named on the command line, showing an error
 * dialog if that fails (see openRemoteRunbookInWindow).
 */
function openRemoteRunbook(win: BrowserWindow, url: string): void {
  void openRemoteRunbookInWindow(win, url, {
    resolveRemote: resolveRemoteRunbook,
    showError: (parent, message, detail) => {
      void dialog.showMessageBox(parent, { type: "error", message, detail })
    },
  })
}

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

const cliConfig = parseCliArgs(process.argv, launchDir, app.getAppPath())

// Before the IPC handlers register, so the renderer's telemetry:config call
// sees the final state. --no-telemetry or RUNBOOKS_TELEMETRY_DISABLE keeps it
// off.
initTelemetry(app.getVersion(), cliConfig.noTelemetry)

// Apply CLI overrides to the shared runtime config.
// Remote URLs are resolved asynchronously after app.whenReady().
//
// If the CLI path is a directory, resolve it to the runbook.mdx inside so that
// `runbookConfig.localPath` is always a concrete file path. The runbook-asset
// protocol handler computes the asset directory via `path.dirname(localPath)`;
// leaving `localPath` as a directory would make `path.dirname` return its
// *parent*, causing asset 404s on any image request that races ahead of the
// renderer's `runbook:get` IPC call (which later re-resolves the path).
let resolvedPath = runbookConfig.localPath
if (cliConfig.runbookPath) {
  resolvedPath = cliConfig.runbookPath
  try {
    if (fs.statSync(resolvedPath).isDirectory()) {
      const candidate = path.join(resolvedPath, "runbook.mdx")
      if (fs.existsSync(candidate)) {
        resolvedPath = candidate
      }
    }
  } catch {
    // stat may fail (e.g. path doesn't exist yet); leave as-is and let the
    // renderer's runbook:get call surface the error.
  }
}
// --watch and --disable-live-file-reload apply to every runbook opened in this
// app instance: runbook:get carries them over when it rebuilds the config.
setRunbookConfig({
  ...runbookConfig,
  localPath: resolvedPath,
  isWatchMode: cliConfig.watch,
  disableLiveFileReload: cliConfig.disableLiveFileReload,
})

// ---------------------------------------------------------------------------
// Native IPC handlers (Electron-only, no backend dependency)
//
// Importing ./ipc/index.ts above already wrapped ipcMain.handle with
// installIpcErrorNormalization() (ipc/ipc-error.ts), so a rejection from
// these handlers, like every other, crosses to the renderer as a clean
// message instead of a FiberFailure dump.
// ---------------------------------------------------------------------------

const ALLOWED_EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"])

ipcMain.handle("native:open-external", async (_event, params: { url: string }) => {
  const parsed = new URL(params.url) // throws on invalid URLs
  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Blocked open-external for scheme: ${parsed.protocol}`)
  }
  await shell.openExternal(params.url)
  return { ok: true as const }
})

ipcMain.handle(
  "native:show-open-dialog",
  async (
    _event,
    params: {
      properties: Array<"openFile" | "openDirectory" | "multiSelections">
      filters?: Electron.FileFilter[]
    },
  ) => {
    const result = await dialog.showOpenDialog({
      properties: params.properties,
      ...dialogDefaultPath(),
      ...(params.filters !== undefined ? { filters: params.filters } : {}),
    })
    return { filePaths: result.filePaths }
  },
)

// Open dialogs at the current runbook's directory when one is loaded, so the
// file browser lands where the user expects. On cold launch, before any
// runbook has been opened, it sets nothing and the OS default applies.
function dialogDefaultPath(): Pick<Electron.OpenDialogOptions, "defaultPath"> {
  if (runbookConfig.localPath) {
    return { defaultPath: path.dirname(runbookConfig.localPath) }
  }
  return {}
}

ipcMain.handle("native:open-runbook-dialog", async () => {
  const win = getMainWindow()
  if (!win) return { ok: false }
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    ...dialogDefaultPath(),
    filters: [
      { name: "Runbook files", extensions: ["mdx", "md"] },
      { name: "All Files", extensions: ["*"] },
    ],
  })
  if (!result.canceled && result.filePaths.length > 0) {
    win.webContents.send("file:open-runbook", { path: result.filePaths[0] })
  }
  return { ok: true }
})

// Triggered by the in-app "Close Runbook" menu item (Header dropdown).
// Routes through main so it uses the same channel as the native menu item —
// renderers listen for "menu:close-runbook" regardless of origin.
ipcMain.handle("native:close-runbook", () => {
  closeRunbook()
  return { ok: true } as const
})

// CLI symlink management
ipcMain.handle("cli:check-install", () => checkCliInstall())
ipcMain.handle("cli:install", () => installCli())

ipcMain.handle("native:get-cli-config", () => ({
  runbookPath: cliConfig.runbookPath,
  remoteUrl: cliConfig.remoteUrl,
  watch: cliConfig.watch,
  noTelemetry: cliConfig.noTelemetry,
  disableLiveFileReload: cliConfig.disableLiveFileReload,
}))

// ---------------------------------------------------------------------------
// macOS: handle open-file events (double-click .mdx in Finder)
// ---------------------------------------------------------------------------

// Holds a path from an open-file event that arrived before the window existed
// (cold launch). The whenReady handler below delivers it once the window is up.
let pendingOpenFilePath: string | null = null

app.on("open-file", (event, filePath) => {
  event.preventDefault()
  const win = getMainWindow()
  if (win) {
    // App already running (e.g. "Open with… > Runbooks"): hand it straight to
    // the window. openRunbookInWindow defers internally if it's mid-load.
    openRunbookInWindow(win, { path: filePath })
  } else {
    // App hasn't finished launching yet (Finder double-click on a cold start).
    // On macOS this event commonly fires before app.whenReady() has created
    // the window, so stash the path for the whenReady handler to open. Also
    // seed runbookConfig.localPath so the runbook-asset protocol resolves
    // assets correctly if an image request races ahead of the renderer's
    // runbook:get call (mirrors the CLI-path handling above).
    pendingOpenFilePath = filePath
    setRunbookConfig({ ...runbookConfig, localPath: filePath })
  }
})

/**
 * Answer a runbook-asset:// request from the open runbook's assets/ folder.
 *
 * Security: resolveRunbookAssetPath returns null unless the URL has the open
 * runbook's host and the file is within its assets/ folder after resolving
 * symlinks, so neither `..` nor a symlink shipped in the runbook dir can serve
 * a file from outside it.
 */
async function serveRunbookAsset(request: Request): Promise<Response> {
  const resolved = await resolveRunbookAssetPath(
    request.url,
    path.dirname(runbookConfig.localPath),
    runbookAssetHost(runbookConfig),
  )
  if (!resolved) {
    return new Response("Forbidden", { status: 403 })
  }

  // <video>/<audio> fetch byte ranges and can only seek when the answer is
  // a 206 with a Content-Range, which net.fetch's file:// response never
  // has, so ranged GETs are answered from the file here. Without a Range
  // header, or with one byteRangeResponse ignores, the whole file is served.
  const rangeHeader = request.headers.get("range")
  if (rangeHeader && request.method === "GET") {
    const partial = await byteRangeResponse(resolved, rangeHeader, getContentType(resolved))
    if (partial) return partial
  }

  return net.fetch(pathToFileURL(resolved).href)
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app
  .whenReady()
  .then(() => {
    installPermissionHandlers(session.defaultSession)
    installClientCertificateHandler(app)

    // Register a protocol handler to serve runbook assets (images, videos, etc.)
    // from the local filesystem. The renderer rewrites ./assets/foo.png to
    // runbook-asset://<host>/foo.png, where <host> is the open runbook's
    // (runbookAssetHost, sent with runbook:get), which this handler resolves
    // relative to the runbook's assets/ folder.
    protocol.handle("runbook-asset", serveRunbookAsset)

    // Pages the Iframe block embeds run in <webview> guests, in sessions of
    // their own (embeds.ts). Only local pages' session serves runbook-asset://.
    const localEmbeds = session.fromPartition(LOCAL_EMBED_PARTITION)
    const webEmbeds = session.fromPartition(WEB_EMBED_PARTITION)
    installEmbedSession(localEmbeds)
    installEmbedSession(webEmbeds)
    localEmbeds.protocol.handle("runbook-asset", serveRunbookAsset)
    const assetHost = () => runbookAssetHost(runbookConfig)
    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "window") {
        contents.on("will-attach-webview", (event, webPreferences, params) => {
          if (!prepareWebviewAttach(webPreferences, params, assetHost())) event.preventDefault()
        })
      } else if (contents.getType() === "webview") {
        // prepareWebviewAttach put every guest it let through in one of the two.
        const partition =
          contents.session === localEmbeds
            ? LOCAL_EMBED_PARTITION
            : contents.session === webEmbeds
              ? WEB_EMBED_PARTITION
              : null
        if (partition) {
          hardenEmbedGuest(contents, partition, assetHost)
        } else {
          contents.close()
        }
      }
    })

    // Apply the persisted theme before creating the window so its background
    // color and title bar overlay are correct on the first frame. The renderer
    // re-confirms over the native:set-theme IPC channel once it mounts.
    nativeTheme.themeSource = getStoredTheme()

    setupApplicationMenu()
    registerAllIpcHandlers()
    createMainWindow()
    initAutoUpdater()

    // Keep the (Windows/Linux) title bar overlay + window background in sync with
    // the effective theme. Fires both when the renderer changes themeSource via
    // the native:set-theme IPC handler and when the OS theme changes while
    // themeSource is 'system'. The initial call covers the case where assigning
    // themeSource above doesn't fire an "updated" event (e.g. when the persisted
    // theme already matches the OS).
    setTitleBarTheme(nativeTheme.shouldUseDarkColors ? "dark" : "light")
    nativeTheme.on("updated", () => {
      setTitleBarTheme(nativeTheme.shouldUseDarkColors ? "dark" : "light")
    })

    // Kick off the boilerplate WASM load as a background task. The full build
    // is ~600-900ms to instantiate; running it now overlaps the cost with the
    // user reading the runbook before their first edit.
    log.info("Starting eager background load of vendored boilerplate WASM")
    eagerLoadBoilerplateWasm()

    // If a runbook was specified via CLI, tell the renderer once it's ready.
    // openRunbookInWindow waits for the page to load, so a remote clone can
    // start right away.
    if (cliConfig.remoteUrl) {
      const win = getMainWindow()
      if (win) openRemoteRunbook(win, cliConfig.remoteUrl)
    } else if (cliConfig.runbookPath) {
      const runbookPath = cliConfig.runbookPath
      const win = getMainWindow()
      if (win) openRunbookInWindow(win, { path: runbookPath })
    } else if (pendingOpenFilePath) {
      // A macOS open-file event (Finder double-click) arrived before the window
      // was ready. Now that the window exists, open the stashed runbook.
      const filePath = pendingOpenFilePath
      pendingOpenFilePath = null
      const win = getMainWindow()
      if (win) openRunbookInWindow(win, { path: filePath })
    }

    app.on("activate", () => {
      focusOrCreateWindow()
    })
  })
  .catch((err: unknown) => {
    log.error("App startup failed:", err)
  })

app.on("window-all-closed", () => {
  app.quit()
})

app.on("will-quit", (event) => {
  // Shutdown is async; use a timeout to avoid blocking it if a fiber never
  // completes.
  event.preventDefault()
  const timeout = setTimeout(() => {
    app.exit(0)
  }, 2000)

  // Stop running scripts first. They run in their own process group, so
  // nothing else signals them when the app exits, and they would otherwise
  // keep running headless. Only the SIGTERM is guaranteed here (the spawner's
  // SIGKILL escalation timer dies with this process), and we don't wait for
  // the scripts to finish: once the app exits their stdout/stderr pipes are
  // closed, so a graceful shutdown that still writes output (e.g. tofu
  // releasing a state lock) can be cut short by SIGPIPE. This runs before the
  // cleanup below so a script is signalled before its temp clone or credential
  // file disappears. The wait is capped at 1 s so that cleanup still runs
  // inside the safety timeout.
  Promise.race([
    cancelAllExecutions(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1000)
    }),
  ])
    .catch((err) => {
      log.error("Error cancelling executions:", err)
    })
    .finally(() => {
      // Clean up any temp clone directories
      cleanupTempClones()

      // Shred the credential files materialised for Google Cloud auth
      cleanupGoogleCredentialFiles()

      // Close the watch-mode file watcher (runtime.dispose doesn't reach it)
      void stopWatcher()

      // Dispose the Effect managed runtime to clean up background fibers,
      // file watchers, etc., while telemetry gets its brief window to send
      // in-flight events.
      void Promise.all([
        runtime.dispose().catch((err) => {
          log.error("Error disposing runtime:", err)
        }),
        shutdownTelemetry(),
      ]).finally(() => {
        clearTimeout(timeout)
        app.exit(0)
      })
    })
})
