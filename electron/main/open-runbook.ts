// Type-only import: this module deliberately has no runtime dependency on
// electron so it stays unit-testable without an Electron runtime (or a
// module mock that would collide with other main-process tests).
import type { BrowserWindow } from "electron"

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
