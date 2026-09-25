/**
 * Watch mode: tells the renderer to reload when the open runbook changes.
 *
 * The main process owns the watcher. `runbook:get` starts it for the loaded
 * runbook when the app was launched with --watch; closing the runbook or
 * quitting stops it. Watching a different runbook replaces the previous
 * watcher (see runbook-watcher.ts).
 *
 * The watcher only signals "reload". The renderer's reload goes back through
 * `runbook:get`, which is the one place the executable registry is rebuilt
 * (or kept frozen under --disable-live-file-reload).
 */
import { ipcMain } from "electron"
import { runtime, runbookConfig } from "./runtime.ts"
import { makeRunbookWatcher } from "./runbook-watcher.ts"
import { validateSessionPath } from "./path-guard.ts"
import { getMainWindow } from "../window.ts"

const runbookWatcher = makeRunbookWatcher(runtime, () => {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send("watch:file-change", { type: "reload" })
})

/** Watch the runbook at `runbookPath` (a no-op if it's already watched). */
export const startWatcher = runbookWatcher.start

/** Stop the watch-mode watcher, if one is running. */
export const stopWatcher = runbookWatcher.stop

export function registerWatchHandlers(): void {
  // runbook:get starts the watcher itself in --watch mode, so the renderer
  // doesn't need this; it lets a renderer opt the open runbook into watching.
  ipcMain.handle(
    "watch:subscribe",
    async (_event, params?: { runbookPath?: string }) => {
      // Prefer the already-trusted runbookConfig.localPath; only use the
      // renderer-supplied path if it passes validation.
      let runbookPath = runbookConfig.localPath
      if (params?.runbookPath && params.runbookPath !== runbookPath) {
        runbookPath = await runtime.runPromise(validateSessionPath(params.runbookPath))
      }

      if (!runbookPath) {
        throw new Error("No runbook path provided and none configured")
      }

      startWatcher(runbookPath)
      return { ok: true as const }
    },
  )
}
