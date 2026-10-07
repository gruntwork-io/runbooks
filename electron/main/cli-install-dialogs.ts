/**
 * Install or uninstall the `runbooks` command and tell the user how it went in
 * a native dialog. Shared by the application menu items and the command
 * palette's IPC channels, so both report the same way.
 */
import { dialog, type MessageBoxOptions } from "electron"
import { errorMessage } from "../../src/errors/message.ts"
import { checkCliInstall, installCli, uninstallCli } from "./cli-install.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("cli-install")

/** Show a CLI error dialog, suppressing user-cancelled admin prompts. */
function showCliError(err: unknown, title: string, message: string): void {
  const detail = errorMessage(err)
  if (detail.includes("User canceled") || detail.includes("dismissed")) return
  dialog.showErrorBox(title, `${message}\n\n${detail}`)
}

/**
 * Show an informational dialog without waiting for the user to dismiss it.
 * The dialog has no parent window and nothing to report back.
 */
function showInfo(options: Omit<MessageBoxOptions, "type">): void {
  dialog.showMessageBox({ type: "info", ...options }).catch((err: unknown) => {
    log.error("Failed to show dialog:", err)
  })
}

/** Install the command unless it already is, and report either way. */
export async function installCliWithDialog(): Promise<void> {
  try {
    const status = await checkCliInstall()
    if (status.installed) {
      showInfo({
        title: "CLI Already Installed",
        message: `The 'runbooks' command is already installed at ${status.symlinkPath}.`,
      })
      return
    }
    const result = await installCli()
    showInfo({
      title: "CLI Installed",
      message: `The 'runbooks' command was installed successfully.`,
      detail: `You can now run 'runbooks' from any terminal.\nInstalled at: ${result.symlinkPath}`,
    })
  } catch (err: unknown) {
    showCliError(err, "CLI Installation Failed", "Could not install the 'runbooks' command:")
  }
}

/** Remove the command if it is ours, and report either way. */
export async function uninstallCliWithDialog(): Promise<void> {
  try {
    // No status pre-check: uninstallCli decides what is ours, which
    // includes a launcher left behind by a moved copy of the app that
    // checkCliInstall reports as not installed.
    const { removed } = await uninstallCli()
    if (!removed) {
      showInfo({
        title: "CLI Not Installed",
        message: "The 'runbooks' command is not currently installed.",
      })
      return
    }
    showInfo({
      title: "CLI Uninstalled",
      message: "The 'runbooks' command has been removed from your PATH.",
    })
  } catch (err: unknown) {
    showCliError(err, "CLI Uninstall Failed", "Could not uninstall the 'runbooks' command:")
  }
}
