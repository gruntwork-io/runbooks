// Type-only import: this module deliberately has no runtime dependency on
// electron so it stays unit-testable without an Electron runtime (or a
// module mock that would collide with other main-process tests).
import type { BrowserWindow } from "electron"
import type { RemoteRunbookResult } from "./remote.ts"
import { redactSecrets } from "../../src/domain/vcs/redact.ts"
import { redactSourceCredentials } from "../../src/remote-source.ts"
import { makeLogger } from "./logger.ts"
import { errorMessage } from "../../src/errors/message.ts"

const log = makeLogger("open-runbook")

/** Payload for the "file:open-runbook" event the renderer listens for. */
export type OpenRunbookPayload = { path: string; remoteSource?: string }

/**
 * Tell a window to open a runbook, deferring until the renderer has finished
 * loading if the page is still in flight.
 *
 * The renderer registers its "file:open-runbook" listener only after its JS
 * runs (around did-finish-load); sending before then silently drops the event.
 * On a cold launch the window is freshly created and still loading when the
 * path arrives, so we can't assume the renderer is listening yet. Checking
 * `isLoading()` sends immediately for an already-loaded window (the "app
 * already running" case, e.g. Finder "Open with… > Runbooks") while deferring
 * for a freshly-created one (the macOS Finder double-click cold-start case).
 */
export function openRunbookInWindow(win: BrowserWindow, payload: OpenRunbookPayload): void {
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("file:open-runbook", payload)
    })
  } else {
    win.webContents.send("file:open-runbook", payload)
  }
}

/**
 * Run `fn` once a cold launch's window is on screen. That window is created
 * hidden and shown at ready-to-show, and a clone can fail (e.g. an unsupported
 * host) before then; a dialog opened on it would appear ahead of the window.
 * Only a hidden window whose page is still loading waits: a loaded window that
 * is not visible (e.g. minimized) runs `fn` now, so the error is never held
 * back for a "show" that may not come.
 */
function whenFirstShown(win: BrowserWindow, fn: () => void): void {
  if (!win.webContents.isLoading() || win.isVisible()) {
    fn()
    return
  }
  win.once("show", () => {
    if (!win.isDestroyed()) fn()
  })
}

/** The two effects openRemoteRunbookInWindow needs, passed in so it stays electron-free. */
export interface OpenRemoteRunbookDeps {
  /** Clone the remote runbook and return where it landed (remote.ts resolveRemoteRunbook). */
  resolveRemote: (url: string) => Promise<RemoteRunbookResult>
  /** Tell the user something went wrong, e.g. with a native error dialog on `win`. */
  showError: (win: BrowserWindow, message: string, detail: string) => void
}

/**
 * Clone a remote runbook named on the command line and open it in `win`.
 *
 * Used for a first launch and for a second instance. Unlike the Open-from-URL
 * modal (runbook:open-remote), nothing in the renderer is waiting on the
 * result, so a failure (no token, a bad ref, no network) is shown to the user
 * through `showError` rather than only logged. The error message carries the
 * clone-failure hint from remote.ts (e.g. "set GITHUB_TOKEN").
 *
 * Never rejects.
 */
export async function openRemoteRunbookInWindow(
  win: BrowserWindow,
  url: string,
  deps: OpenRemoteRunbookDeps,
): Promise<void> {
  let result: RemoteRunbookResult
  try {
    result = await deps.resolveRemote(url)
  } catch (err) {
    log.error("Failed to resolve remote URL:", err)
    if (win.isDestroyed()) return
    const reason = errorMessage(err)
    // The URL is the user's raw input: drop any userinfo typed into it
    // (redactSecrets only knows token shapes), then scrub the whole detail.
    const detail = redactSecrets(`${redactSourceCredentials(url)}\n\n${reason}`)
    whenFirstShown(win, () => deps.showError(win, "Couldn't open runbook", detail))
    return
  }
  if (win.isDestroyed()) return
  openRunbookInWindow(win, { path: result.localPath, remoteSource: result.remoteSource })
}
