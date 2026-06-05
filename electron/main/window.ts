/**
 * BrowserWindow lifecycle management.
 *
 * Centralizes window creation and access so that other modules (menu, updater,
 * CLI open-file) can obtain the main window without circular imports.
 */
import { BrowserWindow, nativeTheme, session, shell } from "electron"
import path from "path"

const ALLOWED_EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"])

/**
 * Title bar overlay + window background colors per theme. The light values
 * approximate --bg-default (the renderer's app background) and
 * --muted-foreground; the dark values mirror their .dark counterparts. Kept in
 * sync with web/src/css/App.css.
 */
const TITLE_BAR_THEMES = {
  light: { color: "#FAF9F5", symbolColor: "#6B7280" },
  dark: { color: "#1F1F1F", symbolColor: "#9CA3AF" },
} as const

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
    // Frameless on all platforms so our custom Header acts as the drag handle.
    // macOS keeps its inset traffic lights; Windows/Linux get an Electron-drawn
    // min/max/close overlay in the top-right. Height matches the renderer
    // header's min-h-16 (64px). The overlay + background colors track the
    // theme (see TITLE_BAR_THEMES / setTitleBarTheme); the initial value
    // follows the OS so there's no flash before the renderer reports its
    // resolved theme via the native:set-theme IPC channel.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin" && {
      titleBarOverlay: {
        ...TITLE_BAR_THEMES[nativeTheme.shouldUseDarkColors ? "dark" : "light"],
        height: 64,
      },
    }),
    backgroundColor:
      TITLE_BAR_THEMES[nativeTheme.shouldUseDarkColors ? "dark" : "light"].color,
    show: false,
  })

  // Set Content Security Policy in production. In dev the CSP is omitted
  // entirely because Vite's HMR requires inline scripts that a strict policy
  // would block. The production CSP still needs 'unsafe-eval' because the
  // MDX runtime compiler requires dynamic code evaluation.
  if (!process.env.ELECTRON_RENDERER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: runbook-asset: https://avatars.githubusercontent.com https://gitlab.com https://secure.gravatar.com; media-src 'self' runbook-asset:; font-src 'self' data:",
          ],
        },
      })
    })
  }

  // Prevent the renderer from opening new Electron windows (e.g. target="_blank"
  // links). Instead, open the URL in the user's default browser if it uses a
  // safe scheme.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
        shell.openExternal(url)
      }
    } catch { /* ignore invalid URLs */ }
    return { action: "deny" }
  })

  // Block in-page navigations that would take the renderer away from the app.
  // In dev, allow same-origin navigations so Vite HMR works normally.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (process.env.ELECTRON_RENDERER_URL) {
      try {
        const devOrigin = new URL(process.env.ELECTRON_RENDERER_URL).origin
        if (new URL(url).origin === devOrigin) return
      } catch { /* fall through to block */ }
    }
    // Production, or a cross-origin navigation in dev — open externally if
    // the scheme is allowed.
    event.preventDefault()
    try {
      const parsed = new URL(url)
      if (ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
        shell.openExternal(url)
      }
    } catch { /* ignore invalid URLs */ }
  })

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
 * Update the native window chrome (title bar overlay + background color) to
 * match the renderer's active theme. Called from the native:set-theme IPC
 * handler. The title bar overlay only exists on Windows/Linux; macOS uses inset
 * traffic lights that need no recoloring.
 */
export function setTitleBarTheme(theme: "light" | "dark"): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const colors = TITLE_BAR_THEMES[theme]
  mainWindow.setBackgroundColor(colors.color)
  if (process.platform !== "darwin") {
    mainWindow.setTitleBarOverlay({ ...colors, height: 64 })
  }
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
