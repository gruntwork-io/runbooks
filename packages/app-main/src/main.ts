/**
 * The rebuilt app's Electron main process. It opens one window, secure by
 * default:
 *
 * - The window is sandboxed and context-isolated, runs no Node, and keeps
 *   web security on. Its preload gives the page the engine bridge and
 *   nothing else (`preload.ts`).
 * - Its session is a partition kept in memory, so the window writes no
 *   storage, cookies or cache to disk. The session denies every permission.
 * - Its page gets a Content-Security-Policy response header from here, where
 *   the page can't loosen it: no 'unsafe-eval', and no inline script or style.
 * - It never navigates away from its page and opens no other window. A link
 *   to an http or https page opens in the browser instead, and a mailto link
 *   in the mail app: the links the window's walk makes clickable.
 *
 * Unpackaged, with ELECTRON_RENDERER_URL set (`electron-vite dev`), it loads
 * that dev server's page and sets no CSP: Vite's React refresh runs an inline
 * script.
 *
 * It hosts the engine (`engine.ts`), which keeps its files in the user data
 * folder, and reads the process's environment once, here, for its runs. The
 * engine serves the window's page over IPC (`ipcServer.ts`), and only it.
 * A runbook given on the command line is opened first (`launch.ts`).
 *
 * A second launch on the same user data folder quits at once, and the first
 * focuses its window.
 *
 * Quitting stops the engine first: its sessions close, and a script still
 * running is sent SIGTERM. The app exits once each such script has ended
 * or had its grace (`stopsEnded`), and at most `QUIT_DEADLINE` after the
 * quit. Electron would exit at once, and the spawner's exit hook would
 * SIGKILL the scripts mid-cleanup.
 */
import path from "node:path"
import { pathToFileURL } from "node:url"
import { app, BrowserWindow, session, shell } from "electron"
import { Cause, Effect, Fiber, Layer } from "effect"
import { stopsEnded } from "@runbooks/platform-node/layers/ChildProcessSpawner"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { appEngine } from "./engine.ts"
import { makeIpcServerProtocol } from "./ipcServer.ts"
import { type Launch, launchArgument, serveLaunch } from "./launch.ts"

/** The repository's version, set by the build (electron.vite.app.config.ts). */
declare const __RUNBOOKS_VERSION__: string

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
 * The page may run the bundle's scripts, load the bundle's stylesheet, and
 * load nothing else: no inline or evaluated script, no inline style, no
 * image, font, frame, plugin or network request, no `<base>`, and no form
 * submission. On a file:// page Chromium counts every file:// URL as 'self',
 * so a script or stylesheet at any local path loads.
 *
 * Without 'unsafe-inline', a `<style>` element or a `style` attribute in
 * markup is refused, but a style set through the CSSOM (`element.style`),
 * as React sets its `style` props, applies. A `url()` in such a style loads
 * nothing: default-src 'none' covers images and fonts.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'"

/** The renderer's page in a build: electron-vite writes main/, preload/ and renderer/ side by side. */
const RENDERER_PAGE = path.join(import.meta.dirname, "../renderer/index.html")

/** The window's preload, built as CommonJS for the sandbox. */
const PRELOAD = path.join(import.meta.dirname, "../preload/index.cjs")

if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), USER_DATA))
}

/**
 * One app per user data folder, whose lock Chromium keeps in it. A second
 * launch on the folder hands its arguments to the first and quits. The
 * first focuses its window and opens nothing.
 */
const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) app.quit()

app.on("second-instance", () => {
  const [appWindow] = BrowserWindow.getAllWindows()
  if (appWindow === undefined) return
  if (appWindow.isMinimized()) appWindow.restore()
  appWindow.focus()
})

/** The runbook the command line names, if any. */
const launch = launched(process.argv)

const processEnvironment: Record<string, string> = {}
for (const [name, value] of Object.entries(process.env))
  if (value !== undefined) processEnvironment[name] = value

// Electron answers a server that asks for a client certificate with the
// first one in the OS store, which identifies the user to that server.
app.on("select-client-certificate", (event, _contents, _url, _certificates, callback) => {
  event.preventDefault()
  callback()
})

app.on("window-all-closed", () => app.quit())

/**
 * How long a quit waits for the engine to stop and its scripts' grace (the
 * spawner's 5 seconds) before the app exits anyway.
 */
const QUIT_DEADLINE = "10 seconds"

/** The engine's fiber, from when the app is ready. */
let engine: Fiber.Fiber<void> | undefined
let quitting: "no" | "stopping the engine" | "stopped" = "no"

app.on("will-quit", (event) => {
  if (engine === undefined || quitting === "stopped") return
  event.preventDefault()
  if (quitting === "stopping the engine") return
  quitting = "stopping the engine"
  Effect.runFork(
    Fiber.interrupt(engine).pipe(
      Effect.andThen(stopsEnded),
      Effect.timeoutOption(QUIT_DEADLINE),
      Effect.ensuring(
        Effect.sync(() => {
          quitting = "stopped"
          // On a later turn: an engine with nothing to stop is done before
          // will-quit's handlers return, and Electron drops a quit made
          // while they run.
          setImmediate(() => app.quit())
        }),
      ),
    ),
  )
})

if (firstInstance)
  app
    .whenReady()
    .then(() => {
      const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
      const page = devServerUrl === undefined ? pathToFileURL(RENDERER_PAGE) : new URL(devServerUrl)
      const appWindow = openWindow(devServerUrl !== undefined)
      engine = Effect.runFork(
        Effect.gen(function* () {
          // Listening before the page loads, so its first message is heard.
          const protocol = yield* makeIpcServerProtocol({
            contents: appWindow.webContents,
            page,
            log: (line) => console.warn(line),
          })
          appWindow
            .loadURL(page.href)
            .catch((error: unknown) => console.error("The window could not load its page:", error))
          return yield* serveLaunch(protocol, launch, (line) => console.error(line)).pipe(
            Effect.provide(
              Layer.merge(
                appEngine({
                  userData: app.getPath("userData"),
                  appVersion: __RUNBOOKS_VERSION__,
                  processEnvironment,
                }),
                NodeFileSystemLive,
              ),
            ),
          )
        }).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.sync(() => console.error("The engine stopped:", Cause.pretty(cause))),
          ),
        ),
      )
    })
    .catch((error: unknown) => {
      console.error("The app could not open its window:", error)
      app.exit(1)
    })

/**
 * The runbook `argv` names, with the folder the app was started in, which
 * `process.cwd()` can't read once that folder is deleted.
 */
function launched(argv: ReadonlyArray<string>): Launch | undefined {
  const argument = launchArgument(argv, process.defaultApp === true)
  if (argument === undefined) return undefined
  let startedIn: string | undefined
  try {
    startedIn = process.cwd()
  } catch {
    startedIn = undefined
  }
  return { argument, startedIn }
}

/** Opens the window, which loads no page yet; on a dev server's, it sets no CSP. */
function openWindow(devServer: boolean): BrowserWindow {
  const windowSession = session.fromPartition(PARTITION)
  windowSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  windowSession.setPermissionCheckHandler(() => false)
  if (!devServer) {
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
      preload: PRELOAD,
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
  return appWindow
}

/** The schemes the OS may open for the window: the browser's, and the mail app's. */
const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"])

/** Opens an http, https or mailto URL in the app the OS has for it, and does nothing with any other. */
function openInBrowser(url: string): void {
  const parsed = URL.parse(url)
  if (parsed === null || !EXTERNAL_SCHEMES.has(parsed.protocol)) return
  shell
    .openExternal(parsed.href)
    .catch((error: unknown) => console.error("A link could not open outside the app:", error))
}
