// Suppress the CSP security warning in development — Vite's HMR requires
// inline scripts which are incompatible with a strict CSP. The production
// build sets a proper CSP via session.webRequest headers.
if (process.env.ELECTRON_RENDERER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true"
}

import { app, shell, ipcMain, dialog, protocol, net, nativeTheme } from "electron"
import * as path from "path"
import * as fs from "fs"
import * as tls from "node:tls"
import { createMainWindow, focusOrCreateWindow, getMainWindow, setTitleBarTheme } from "./window.ts"
import { openRunbookInWindow } from "./open-runbook.ts"
import { getStoredTheme } from "./theme-store.ts"
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
import { Effect } from "effect"
import { coldReadSystemPems, installSystemTrust, refreshSystemPems } from "../../src/domain/tls/system-ca.ts"
import { registerSecret, VCS_TOKEN_ENV_VARS } from "../../src/domain/vcs/redact.ts"
import type { CaSources } from "../../src/domain/tls/system-ca.ts"

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
// System-trust TLS: make every Node TLS
// client in the main process (VCS HttpClient layers, OAuth device flow, AWS
// SDK, Mixpanel) honor the OS trust store in ADDITION to Node's bundled
// Mozilla roots, so a custom enterprise root CA installed in the OS store
// stops failing token validation as "Invalid credentials detected". Strictly
// additive — verification is never disabled.
// ---------------------------------------------------------------------------

// Snapshot the bundled defaults BEFORE the first setDefaultCACertificates:
// afterwards getCACertificates("default") returns the previously-installed
// union, so re-reading "default" later would compound extras into the base.
const bundledCaDefaults = tls.getCACertificates("default") // Mozilla roots + NODE_EXTRA_CA_CERTS
// "system" reads are cached for process lifetime and trust install is
// per-thread — see the CAVEATS in system-ca.ts.
let lastKnownSystemPems: string[] = [...tls.getCACertificates("system")]

// Extra PEMs beyond the OS store (glab per-host ca_cert contents — the
// harvest, wired in during host enumeration). Mutated in place so re-installs
// always include them.
const harvestedCaPems: string[] = []

// Dev/test-only extraPems seam: RUNBOOKS_TEST_EXTRA_CA points at a PEM
// file read FRESH on every install/refresh, so an e2e can inject a CA
// mid-session and assert the TLS card's Retry recovers without relaunch. The
// OS-store-mutated leg is physically untestable in CI (no keychain mutation)
// and is covered by the manual QA gate.
function testSeamPems(): string[] {
  const seamPath = process.env.RUNBOOKS_TEST_EXTRA_CA
  if (!seamPath) return []
  try {
    const pem = fs.readFileSync(seamPath, "utf8")
    return pem.includes("-----BEGIN CERTIFICATE-----") ? [pem] : []
  } catch {
    return []
  }
}

const extraPemsForInstall = (): string[] => [...harvestedCaPems, ...testSeamPems()]

const caSources = (systemPems: string[]): CaSources => ({
  bundledDefaults: () => [...bundledCaDefaults],
  systemPems: () => Effect.succeed(systemPems),
  setCAs: (certs) => tls.setDefaultCACertificates(certs),
})

// The count log line doubles as the e2e trust canary (asserts system > 0
// on the macOS runner) — keep its format stable.
function installAndLog(systemPems: string[], note?: string): void {
  const counts = Effect.runSync(installSystemTrust(extraPemsForInstall(), caSources(systemPems)))
  log.info(
    `installSystemTrust: defaults=${counts.defaults} system=${counts.system} extra=${counts.extra}${note ? ` (${note})` : ""}`,
  )
}

// The launch-time install.
installAndLog(lastKnownSystemPems)

/**
 * Mid-session trust refresh. Node caches getCACertificates("system")
 * for process lifetime, so a CA installed after launch is only observable via
 * a COLD out-of-process read (process.execPath with ELECTRON_RUN_AS_NODE=1).
 * On any child failure the launch-time set is used instead — never worse than
 * launch. Returns coldReadOk so callers can degrade the TLS-card copy to
 * "…then restart Runbooks" when the child itself failed.
 *
 * Runs on: every TLS-classified validation failure (once, before any error
 * surfaces), the TLS card's Retry, HostSelect Reload, and GitHub Check again.
 */
export async function refreshSystemTrust(): Promise<{ coldReadOk: boolean }> {
  const { pems, coldReadOk } = await runtime.runPromise(
    refreshSystemPems(coldReadSystemPems(), lastKnownSystemPems),
  )
  if (coldReadOk) {
    lastKnownSystemPems = [...pems]
  }
  installAndLog(pems, `refresh, coldReadOk=${coldReadOk}`)
  return { coldReadOk }
}

/**
 * Register extra trust PEMs harvested from glab per-host `ca_cert` config
 * and re-install the union. Strictly additive; idempotent. Called from
 * the gitlab:enumerate-hosts handler on every host enumeration.
 */
export function registerExtraCaPems(pems: string[]): void {
  const unchanged =
    pems.length === harvestedCaPems.length && pems.every((pem, i) => pem === harvestedCaPems[i])
  if (unchanged) return
  harvestedCaPems.splice(0, harvestedCaPems.length, ...pems)
  installAndLog(lastKnownSystemPems, "glab ca_cert harvest")
}

// Point the boilerplate renderer at the bundled CLI + WASM artifacts the
// `just fetch-boilerplate` recipe drops under resources/. In packaged
// builds, electron-builder.extraResources puts them next to app.asar; in
// dev (`electron-vite dev`), app.getAppPath() is the repo root. User-set
// env vars win so devs can still override with a custom build.
{
  // Packaged: extraResources lands files under process.resourcesPath
  // (e.g. .app/Contents/Resources/bin, .../wasm). Dev (electron <main.js>
  // or electron-vite dev): __dirname is <repo>/dist/main, so resources/
  // sits two levels up. electron-vite shims __dirname for ESM builds.
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, "..", "..", "resources")
  if (!process.env.BOILERPLATE_BIN) {
    const bundled = path.join(
      resourcesDir,
      "bin",
      process.platform === "win32" ? "boilerplate.exe" : "boilerplate",
    )
    if (fs.existsSync(bundled)) process.env.BOILERPLATE_BIN = bundled
  }
  if (!process.env.BOILERPLATE_WASM_DIR) {
    const bundledWasmDir = path.join(resourcesDir, "wasm")
    if (fs.existsSync(path.join(bundledWasmDir, "boilerplate-full.wasm.br"))) {
      process.env.BOILERPLATE_WASM_DIR = bundledWasmDir
    }
  }
}

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
