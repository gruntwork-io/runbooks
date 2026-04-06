/**
 * Auto-update support via electron-updater.
 *
 * Checks for updates after app launch, downloads in the background, and
 * prompts the user to restart when a new version is ready to install.
 * Disabled entirely when running in development mode.
 */
import { autoUpdater } from "electron-updater"
import { app, dialog } from "electron"
import { makeLogger } from "./logger.ts"

const log = makeLogger("updater")
const isDev = !app.isPackaged

const UPDATE_CHECK_DELAY_MS = 10_000

/** Initialize the auto-updater. Call once on app ready. */
export function initAutoUpdater(): void {
  if (isDev) {
    log.info("Skipping auto-update in development mode")
    return
  }

  // Don't auto-download — we want to notify first.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on("checking-for-update", () => {
    log.info("Checking for update…")
  })

  autoUpdater.on("update-available", (info) => {
    log.info(`Update available: ${info.version}`)
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Available",
        message: `A new version (${info.version}) is available. It will be downloaded in the background.`,
        buttons: ["OK"],
      })
      .then(() => {
        autoUpdater.downloadUpdate()
      })
  })

  autoUpdater.on("update-not-available", () => {
    log.info("No update available")
  })

  autoUpdater.on("download-progress", (progress) => {
    log.info(`Download progress: ${Math.round(progress.percent)}%`)
  })

  autoUpdater.on("update-downloaded", (info) => {
    log.info(`Update downloaded: ${info.version}`)
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Ready",
        message: `Version ${info.version} has been downloaded. Restart now to apply the update?`,
        buttons: ["Restart", "Later"],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall()
        }
      })
  })

  autoUpdater.on("error", (err) => {
    log.error("Error:", err.message)
  })

  // Delay the first check so the window has time to appear.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error("Check failed:", err.message)
    })
  }, UPDATE_CHECK_DELAY_MS)
}
