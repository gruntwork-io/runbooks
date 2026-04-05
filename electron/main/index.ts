// Suppress the CSP security warning in development — Vite's HMR requires
// inline scripts which are incompatible with a strict CSP. The production
// build sets a proper CSP via session.webRequest headers.
if (process.env.ELECTRON_RENDERER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"
}

import { app, BrowserWindow, shell, ipcMain, dialog, protocol, net } from "electron"
import * as path from "path"
import * as fs from "fs"
import { createMainWindow, focusOrCreateWindow, getMainWindow } from "./window.ts"
import { setupApplicationMenu } from "./menu.ts"
import { initAutoUpdater } from "./updater.ts"
import { parseCliArgs } from "./cli.ts"
import { registerAllIpcHandlers } from "./ipc/index.ts"
import { runtime, setRunbookConfig, runbookConfig } from "./ipc/runtime.ts"

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
    // If the second instance was launched with a runbook path, forward it.
    const secondArgs = parseCliArgs(argv)
    if (secondArgs.runbookPath) {
      win.webContents.send("file:open-runbook", secondArgs.runbookPath)
    }
  })
}

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

const cliConfig = parseCliArgs()

// Apply CLI overrides to the shared runtime config.
if (cliConfig.runbookPath) {
  setRunbookConfig({
    ...runbookConfig,
    localPath: cliConfig.runbookPath,
    isWatchMode: cliConfig.watch,
  })
}
if (cliConfig.watch) {
  setRunbookConfig({ ...runbookConfig, isWatchMode: true })
}

// ---------------------------------------------------------------------------
// Native IPC handlers (Electron-only, no backend dependency)
// ---------------------------------------------------------------------------

ipcMain.handle("native:open-external", async (_event, params: { url: string }) => {
  await shell.openExternal(params.url)
  return { ok: true as const }
})

ipcMain.handle(
  "native:show-open-dialog",
  async (_event, params: { properties: Array<"openFile" | "openDirectory" | "multiSelections">; filters?: Electron.FileFilter[] }) => {
    const result = await dialog.showOpenDialog({
      properties: params.properties,
      filters: params.filters,
    })
    return { filePaths: result.filePaths }
  },
)

ipcMain.handle("native:get-app-info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
}))

ipcMain.handle("native:get-cli-config", () => ({
  runbookPath: cliConfig.runbookPath,
  watch: cliConfig.watch,
  workingDir: cliConfig.workingDir,
  outputPath: cliConfig.outputPath,
  noTelemetry: cliConfig.noTelemetry,
}))

// ---------------------------------------------------------------------------
// macOS: handle open-file events (double-click .mdx in Finder)
// ---------------------------------------------------------------------------

app.on("open-file", (event, filePath) => {
  event.preventDefault()
  const win = getMainWindow()
  if (win) {
    win.webContents.send("file:open-runbook", filePath)
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

    // Security: ensure the resolved path is within the runbook directory
    const resolved = path.resolve(assetPath)
    if (!resolved.startsWith(path.resolve(runbookDir))) {
      return new Response("Forbidden", { status: 403 })
    }

    return net.fetch(`file://${resolved}`)
  })

  setupApplicationMenu()
  registerAllIpcHandlers()
  createMainWindow()
  initAutoUpdater()

  // If a runbook was specified via CLI, tell the renderer once it's ready.
  if (cliConfig.runbookPath) {
    const win = getMainWindow()
    win?.webContents.once("did-finish-load", () => {
      win.webContents.send("file:open-runbook", cliConfig.runbookPath)
    })
  }

  app.on("activate", () => {
    focusOrCreateWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("will-quit", () => {
  // Dispose the Effect managed runtime to clean up background fibers,
  // file watchers, etc.
  runtime.dispose().catch((err) => {
    console.error("[main] Error disposing runtime:", err)
  })
})
