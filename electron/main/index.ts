// Suppress the CSP security warning in development — Vite's HMR requires
// inline scripts which are incompatible with a strict CSP. The production
// build sets a proper CSP via session.webRequest headers.
if (process.env.ELECTRON_RENDERER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"
}

import { app, shell, ipcMain, dialog, protocol, net } from "electron"
import * as path from "path"
import * as fs from "fs"
import { createMainWindow, focusOrCreateWindow, getMainWindow } from "./window.ts"
import { setupApplicationMenu } from "./menu.ts"
import { initAutoUpdater } from "./updater.ts"
import { parseCliArgs } from "./cli.ts"
import { registerAllIpcHandlers } from "./ipc/index.ts"
import { checkCliInstall, installCli, uninstallCli } from "./cli-install.ts"
import { runtime, setRunbookConfig, runbookConfig } from "./ipc/runtime.ts"
import { resolveRemoteRunbook, cleanupTempClones } from "./remote.ts"
import { isContainedIn } from "../../src/path-validation.ts"
import { makeLogger } from "./logger.ts"
import { populateShellEnv } from "./shell-env.ts"
import { eagerLoadInBackground as eagerLoadBoilerplateWasm, isWasmConfigured } from "../../src/layers/NodeWasmRuntime.ts"

const log = makeLogger("main")

// Pre-populate process.env from the user's login shell so that PATH and
// other profile-driven vars are visible to scripts we spawn. Must run
// before SessionManager captures process.env on first runbook load.
populateShellEnv()

// ---------------------------------------------------------------------------
// Register the runbook-asset protocol as privileged so it can be used in img
// src, video src, etc. Must be called before app.whenReady().
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: "runbook-asset",
    privileges: { standard: false, secure: true, supportFetchAPI: true },
  },
])

// ---------------------------------------------------------------------------
// Single instance lock — focus existing window instead of opening a second.
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv) => {
    const win = focusOrCreateWindow()
    const secondArgs = parseCliArgs(argv)
    if (secondArgs.remoteUrl) {
      resolveRemoteRunbook(secondArgs.remoteUrl)
        .then((result) => {
          win.webContents.send("file:open-runbook", {
            path: result.localPath,
            remoteSource: result.remoteSource,
          })
        })
        .catch((err) => {
          log.error("Failed to resolve remote URL:", err)
        })
    } else if (secondArgs.runbookPath) {
      win.webContents.send("file:open-runbook", { path: secondArgs.runbookPath })
    }
  })
}

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

const cliConfig = parseCliArgs()

// Apply CLI overrides to the shared runtime config.
// Remote URLs are resolved asynchronously after app.whenReady().
//
// If the CLI path is a directory, resolve it to the runbook.mdx inside so that
// `runbookConfig.localPath` is always a concrete file path. The runbook-asset
// protocol handler computes the asset directory via `path.dirname(localPath)`;
// leaving `localPath` as a directory would make `path.dirname` return its
// *parent*, causing asset 404s on any image request that races ahead of the
// renderer's `runbook:get` IPC call (which later re-resolves the path).
if (cliConfig.runbookPath) {
  let resolvedPath = cliConfig.runbookPath
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
  setRunbookConfig({
    ...runbookConfig,
    localPath: resolvedPath,
    isWatchMode: cliConfig.watch,
    disableLiveFileReload: cliConfig.disableLiveFileReload,
  })
}
if (cliConfig.watch) {
  setRunbookConfig({ ...runbookConfig, isWatchMode: true, disableLiveFileReload: cliConfig.disableLiveFileReload })
}

// ---------------------------------------------------------------------------
// Native IPC handlers (Electron-only, no backend dependency)
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
  async (_event, params: { properties: Array<"openFile" | "openDirectory" | "multiSelections">; filters?: Electron.FileFilter[] }) => {
    const result = await dialog.showOpenDialog({
      properties: params.properties,
      defaultPath: getDialogDefaultPath(),
      filters: params.filters,
    })
    return { filePaths: result.filePaths }
  },
)

// Open dialogs at the current runbook's directory when one is loaded, so the
// file browser lands where the user expects. Falls back to undefined (OS
// default) on cold launch before any runbook has been opened.
function getDialogDefaultPath(): string | undefined {
  if (runbookConfig.localPath) {
    return path.dirname(runbookConfig.localPath)
  }
  return undefined
}

ipcMain.handle("native:open-runbook-dialog", async () => {
  const win = getMainWindow()
  if (!win) return { ok: false }
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    defaultPath: getDialogDefaultPath(),
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
  getMainWindow()?.webContents.send("menu:close-runbook")
  return { ok: true } as const
})

ipcMain.handle("native:get-app-info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
}))

// CLI symlink management
ipcMain.handle("cli:check-install", () => checkCliInstall())
ipcMain.handle("cli:install", () => installCli())
ipcMain.handle("cli:uninstall", () => uninstallCli())

ipcMain.handle("native:get-cli-config", () => ({
  runbookPath: cliConfig.runbookPath,
  remoteUrl: cliConfig.remoteUrl,
  watch: cliConfig.watch,
  outputPath: cliConfig.outputPath,
  noTelemetry: cliConfig.noTelemetry,
  disableLiveFileReload: cliConfig.disableLiveFileReload,
}))

// ---------------------------------------------------------------------------
// macOS: handle open-file events (double-click .mdx in Finder)
// ---------------------------------------------------------------------------

app.on("open-file", (event, filePath) => {
  event.preventDefault()
  const win = getMainWindow()
  if (win) {
    win.webContents.send("file:open-runbook", { path: filePath })
  } else {
    // App hasn't finished launching yet — stash the path so we can open it
    // once the window is ready.
    setRunbookConfig({ ...runbookConfig, localPath: filePath })
  }
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // Register a protocol handler to serve runbook assets (images, videos, etc.)
  // from the local filesystem. The renderer rewrites ./assets/foo.png to
  // runbook-asset://assets/foo.png which this handler resolves relative to the
  // runbook directory.
  protocol.handle("runbook-asset", (request) => {
    // URL looks like: runbook-asset://assets/foo.png
    const url = new URL(request.url)
    // Combine host + pathname to get the relative asset path (e.g. "assets/foo.png")
    const assetRelative = url.hostname + url.pathname
    const runbookDir = path.dirname(runbookConfig.localPath)
    const assetPath = path.join(runbookDir, assetRelative)

    // Security: ensure the resolved path is within the runbook directory.
    // Uses isContainedIn which appends path.sep to prevent prefix-matching
    // bypass (e.g. /tmp/my-runbook-evil matching /tmp/my-runbook).
    const resolved = path.resolve(assetPath)
    if (!isContainedIn(resolved, path.resolve(runbookDir))) {
      return new Response("Forbidden", { status: 403 })
    }

    return net.fetch(`file://${resolved}`)
  })

  setupApplicationMenu()
  registerAllIpcHandlers()
  createMainWindow()
  initAutoUpdater()

  // Kick off the boilerplate WASM load as a background task. The full build
  // is ~600-900ms to instantiate; running it now overlaps the cost with the
  // user reading the runbook before their first edit. Gated on
  // BOILERPLATE_WASM_DIR — without it, the cold subprocess renderer is used.
  if (isWasmConfigured()) {
    log.info("Boilerplate WASM dir configured, starting eager background load")
    eagerLoadBoilerplateWasm()
  }

  // If a runbook was specified via CLI, tell the renderer once it's ready.
  if (cliConfig.remoteUrl) {
    const win = getMainWindow()
    win?.webContents.once("did-finish-load", () => {
      resolveRemoteRunbook(cliConfig.remoteUrl!)
        .then((result) => {
          win.webContents.send("file:open-runbook", {
            path: result.localPath,
            remoteSource: result.remoteSource,
          })
        })
        .catch((err) => {
          log.error("Failed to resolve remote URL:", err)
        })
    })
  } else if (cliConfig.runbookPath) {
    const win = getMainWindow()
    win?.webContents.once("did-finish-load", () => {
      win.webContents.send("file:open-runbook", { path: cliConfig.runbookPath })
    })
  }

  app.on("activate", () => {
    focusOrCreateWindow()
  })
})

app.on("window-all-closed", () => {
  app.quit()
})

app.on("will-quit", (event) => {
  // Clean up any temp clone directories
  cleanupTempClones()

  // Dispose the Effect managed runtime to clean up background fibers,
  // file watchers, etc. Use a timeout to avoid blocking shutdown if a
  // fiber never completes.
  event.preventDefault()
  const timeout = setTimeout(() => {
    app.exit(0)
  }, 2000)
  runtime
    .dispose()
    .catch((err) => {
      log.error("Error disposing runtime:", err)
    })
    .finally(() => {
      clearTimeout(timeout)
      app.exit(0)
    })
})
