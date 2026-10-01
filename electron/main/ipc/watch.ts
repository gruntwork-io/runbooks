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
 *
 * A second watcher, in every mode, covers the script files the registry was
 * built from. It only signals which blocks' scripts were written: those
 * blocks then ask `runbook:script-change` what differs, and the registry
 * keeps its copy until the user reloads the script (`runbook:reload-script`).
 */
import { ipcMain } from "electron"
import { runtime, runbookConfig, executableRegistry } from "./runtime.ts"
import { makeRunbookWatcher, makeScriptWatcher } from "./runbook-watcher.ts"
import { validateSessionPath } from "./path-guard.ts"
import { supersedeRunbookLoads } from "./runbook.ts"
import { getMainWindow } from "../window.ts"

const runbookWatcher = makeRunbookWatcher(runtime, (runbookPath) => {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send("watch:file-change", { type: "reload", path: runbookPath })
})

const scriptWatcher = makeScriptWatcher(runtime, (scriptsWritten) => {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  // Only the blocks that run a written script compare it with the registry.
  const componentIds = executableRegistry?.getComponentIdsForScripts(scriptsWritten) ?? []
  if (componentIds.length === 0) return
  win.webContents.send("watch:script-change", { componentIds })
})

/** Watch the runbook at `runbookPath` (a no-op if it's already watched). */
export const startWatcher = runbookWatcher.start

/**
 * Watch the script files at `scriptPaths` (a no-op if exactly those are
 * already watched). An empty list stops the script watcher.
 */
export const watchScripts = scriptWatcher.watch

/** Stop the watch-mode watcher and the script watcher, whichever are running. */
export const stopWatchers = (): Promise<void> =>
  Promise.all([runbookWatcher.stop(), scriptWatcher.stop()]).then(() => undefined)

/**
 * Close the open runbook: stop watching it and tell the renderer to close it.
 * Every close path (native menu, in-app menu) goes through here so none of
 * them leaves a watcher running on a runbook that is no longer open. A
 * runbook:get still running is superseded first, so it can't start a watcher
 * or set a registry once it resumes.
 */
export function closeRunbook(): void {
  supersedeRunbookLoads()
  void stopWatchers()
  getMainWindow()?.webContents.send("menu:close-runbook")
}

export function registerWatchHandlers(): void {
  // Kept for the declared channel contract; nothing calls it. runbook:get
  // owns starting the watcher (in --watch mode), and the renderer only
  // listens for watch:file-change when runbook:get reports isWatchMode.
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
