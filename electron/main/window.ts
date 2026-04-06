/**
 * BrowserWindow lifecycle management.
 *
 * Centralizes window creation and access so that other modules (menu, updater,
 * CLI open-file) can obtain the main window without circular imports.
 */
import { BrowserWindow, session } from "electron"
import path from "path"

let mainWindow: BrowserWindow | null = null

/**
 * Create the main application window with secure defaults.
 * Returns the new BrowserWindow instance.
 */
export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "../../build/icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    show: false,
  })

  // Set Content Security Policy in production to silence the Electron security
  // warning. Skipped in dev because Vite's HMR requires inline scripts.
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: runbook-asset:; media-src 'self' runbook-asset:; font-src 'self' data:",
          ],
        },
      })
    })
  }

  // Avoid white flash — only show once content is painted.
  mainWindow.on("ready-to-show", () => {
    mainWindow?.show()
  })

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  // In dev, load from Vite dev server; in prod, load the built file.
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"))
  }

  return mainWindow
}

/** Returns the current main window, or null if it has been closed. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * Focus the existing main window if it exists, otherwise create a new one.
 * Useful for macOS `activate` events when the dock icon is clicked.
 */
export function focusOrCreateWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    return mainWindow
  }
  return createMainWindow()
}
