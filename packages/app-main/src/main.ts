/**
 * The rebuilt app's Electron main process. It opens one window, secure by
 * default:
 *
 * - The window is sandboxed and context-isolated, runs no Node and no
 *   preload, and keeps web security on.
 * - Its session is a partition kept in memory, so the window writes no
 *   storage, cookies or cache to disk. The session denies every permission.
 * - Its page gets a Content-Security-Policy response header from here, where
 *   the page can't loosen it: no 'unsafe-eval' and no inline script.
 * - It never navigates away from its page and opens no other window. A link
 *   to an http or https page opens in the browser instead.
 *
 * Unpackaged, with ELECTRON_RENDERER_URL set (`electron-vite dev`), it loads
 * that dev server's page and sets no CSP: Vite's React refresh runs an inline
 * script.
 */
import path from "node:path"
import { app, BrowserWindow, session, shell } from "electron"

/**
 * The app's user data folder, in the OS's app data folder. The old app's is
 * `runbooks`. An app Electron starts from a file, as electron-vite and
 * Playwright start this one, is named "Electron", and every such app would
 * share that name's folder. `--user-data-dir` still chooses another.
 */
const USER_DATA = "runbooks-rebuild"

/** The window's session. A partition without the `persist:` prefix is kept in memory. */
const PARTITION = "window"

/**
 * The page may run the bundle's scripts and load nothing else: no inline or
 * evaluated script, no stylesheet, image, font, frame, plugin or network
 * request, no `<base>`, and no form submission. On a file:// page Chromium
 * counts every file:// URL as 'self', so a script at any local path loads.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'"

/** The renderer's page in a build: electron-vite writes main/ and renderer/ side by side. */
const RENDERER_PAGE = path.join(import.meta.dirname, "../renderer/index.html")

if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), USER_DATA))
}

// Electron answers a server that asks for a client certificate with the
// first one in the OS store, which identifies the user to that server.
app.on("select-client-certificate", (event, _contents, _url, _certificates, callback) => {
  event.preventDefault()
  callback()
})

app.on("window-all-closed", () => app.quit())

app
  .whenReady()
  .then(() => openWindow(app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL))
  .catch((error: unknown) => {
    console.error("The app could not open its window:", error)
    app.exit(1)
  })

/** Opens the window on the renderer's page, or on the dev server's when there is one. */
function openWindow(devServerUrl: string | undefined): void {
  const windowSession = session.fromPartition(PARTITION)
  windowSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  windowSession.setPermissionCheckHandler(() => false)
  if (devServerUrl === undefined) {
    windowSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
        },
      })
    })
  }

  const appWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      session: windowSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  })
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)
    return { action: "deny" }
  })
  appWindow.webContents.on("will-navigate", (event, url) => {
    event.preventDefault()
    openInBrowser(url)
  })

  const loaded =
    devServerUrl === undefined ? appWindow.loadFile(RENDERER_PAGE) : appWindow.loadURL(devServerUrl)
  loaded.catch((error: unknown) => console.error("The window could not load its page:", error))
}

/** Opens an http or https URL in the browser, and does nothing with any other. */
function openInBrowser(url: string): void {
  const parsed = URL.parse(url)
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") return
  shell
    .openExternal(parsed.href)
    .catch((error: unknown) => console.error("A link could not open in the browser:", error))
}
