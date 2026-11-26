/**
 * The rebuilt app's Electron main process. It opens one window, secure by
 * default:
 *
 * - The window is sandboxed and context-isolated, runs no Node, and keeps
 *   web security on. Its preload gives the page the engine bridge and
 *   nothing else (`preload.ts`).
 * - Its session is a partition kept in memory, so the window writes no
 *   storage, cookies or cache to disk. The session denies every permission.
 * - Its page comes from `runbooks-app://window/`, a scheme of its own that
 *   only the window's session serves, from the renderer's build and nothing
 *   outside it (`pageScheme.ts`), so the page's origin is its own.
 * - An open runbook's images and media come from
 *   `runbook-asset://<session id>/`, which the window's session serves from
 *   that runbook's assets/ folder through the path guard (`runbookAssets.ts`).
 * - Its page gets a Content-Security-Policy response header from here, where
 *   the page can't loosen it: no 'unsafe-eval', and no inline script or style
 *   (`contentSecurityPolicy.ts`).
 * - It never navigates away from its page and opens no other window. A link
 *   to an http or https page opens in the browser instead, and a mailto link
 *   in the mail app: the links the window's walk makes clickable.
 *
 * Unpackaged, with ELECTRON_RENDERER_URL set (`electron-vite dev`), it loads
 * that dev server's page, under the same CSP plus the scripts and styles the
 * dev server tags and its socket.
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
import { app, BrowserWindow, net, protocol, type Session, session, shell } from "electron"
import { Cause, Effect, Fiber, FiberSet, Layer, type Scope, Semaphore } from "effect"
import type { Rpc } from "effect/rpc"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { EngineCommand } from "@runbooks/core/protocol"
import type { FileSystem } from "@runbooks/core/services/FileSystem"
import { stopsEnded } from "@runbooks/platform-node/layers/ChildProcessSpawner"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { contentSecurityPolicy } from "./contentSecurityPolicy.ts"
import { appEngine } from "./engine.ts"
import { makeIpcServerProtocol } from "./ipcServer.ts"
import { type Launch, launchArgument, serveLaunch } from "./launch.ts"
import { APP_PAGE, pageFile } from "./pageScheme.ts"
import { notFound } from "./pathGuard.ts"
import { serveRunbookAsset, sessionRunbook } from "./runbookAssets.ts"
import { ASSET_SCHEME, PAGE_SCHEME } from "./schemes.ts"

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

/** The renderer's build: electron-vite writes main/, preload/ and renderer/ side by side. */
const RENDERER = path.join(import.meta.dirname, "../renderer")

/** The window's preload, built as CommonJS for the sandbox. */
const PRELOAD = path.join(import.meta.dirname, "../preload/index.cjs")

if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), USER_DATA))
}

// Before the app is ready, and in one call: Electron allows only one.
//
// A runbook's assets are standard, so a <video> or <audio> can seek: a seek
// past what the first response delivered makes Chromium's media loader send
// a second range request, which fails for a non-standard scheme with
// PIPELINE_ERROR_READ. `stream` tells media elements to expect a streamed
// body; without it the old app's media failed with "Format error" before it
// answered range requests. Both secure, so neither is mixed content.
protocol.registerSchemesAsPrivileged([
  { scheme: PAGE_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, stream: true } },
])

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
      const devServer = devServerUrl === undefined ? undefined : new URL(devServerUrl)
      const page = devServer ?? APP_PAGE
      const appWindow = openWindow(devServer)
      engine = Effect.runFork(
        Effect.gen(function* () {
          // Listening before the page loads, so its first message is heard.
          const ipcProtocol = yield* makeIpcServerProtocol({
            contents: appWindow.webContents,
            page,
            log: (line) => console.warn(line),
          })
          appWindow
            .loadURL(page.href)
            .catch((error: unknown) => console.error("The window could not load its page:", error))
          // The page asks for an asset only once the engine has answered it,
          // and serveLaunch answers it only after the handler is in place.
          return yield* Effect.andThen(
            serveRunbookAssets(appWindow.webContents.session),
            serveLaunch(ipcProtocol, launch, (line) => console.error(line)),
          ).pipe(
            Effect.scoped,
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

/** Opens the window, which loads no page yet, for the build's page or the dev server's at `devServer`. */
function openWindow(devServer: URL | undefined): BrowserWindow {
  const windowSession = session.fromPartition(PARTITION)
  windowSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  windowSession.setPermissionCheckHandler(() => false)
  const policy = contentSecurityPolicy(devServer)
  windowSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    })
  })
  windowSession.protocol.handle(PAGE_SCHEME, servePage)

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

/** Answers a request for the page's scheme from the renderer's build, through the path guard. */
function servePage(request: Request): Promise<Response> {
  return Effect.runPromise(
    pageFile(request.url, RENDERER).pipe(
      Effect.flatMap((file) =>
        file === undefined
          ? Effect.succeed(notFound())
          : Effect.tryPromise(() => net.fetch(pathToFileURL(file).href)),
      ),
      Effect.orElseSucceed(notFound),
      Effect.provide(NodeFileSystemLive),
    ),
  )
}

/** How many asset requests main resolves at once; the rest wait their turn. */
const MAX_ASSET_LOOKUPS = 16

/**
 * Serves the assets of the runbooks the engine has open on `windowSession`,
 * through the path guard (runbookAssets.ts), until the scope closes. It asks
 * the engine in context which runbook a host's session has open.
 */
const serveRunbookAssets = (
  windowSession: Session,
): Effect.Effect<void, never, Scope.Scope | FileSystem | Rpc.ToHandler<EngineCommand>> =>
  Effect.gen(function* () {
    const runbookOf = sessionRunbook(yield* makeInProcessClient("person"))
    const lookups = yield* Semaphore.make(MAX_ASSET_LOOKUPS)
    const run = yield* FiberSet.makeRuntimePromise<FileSystem>()
    windowSession.protocol.handle(ASSET_SCHEME, (request) =>
      run(lookups.withPermits(1)(serveRunbookAsset(request, runbookOf))),
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => windowSession.protocol.unhandle(ASSET_SCHEME)),
    )
  })

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
