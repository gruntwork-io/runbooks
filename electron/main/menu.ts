/**
 * Native application menu.
 *
 * Builds a platform-appropriate menu bar with standard edit/view/window items
 * plus app-specific actions (Open Runbook, docs links, etc.).
 */
import * as path from "path"
import { app, Menu, dialog, shell, type MenuItemConstructorOptions } from "electron"
import { getMainWindow } from "./window.ts"
import { checkCliInstall, installCli, uninstallCli } from "./cli-install.ts"
import { runbookConfig } from "./ipc/runtime.ts"

const isMac = process.platform === "darwin"

const DOCS_URL = "https://docs.gruntwork.io/runbooks"
const ISSUES_URL = "https://github.com/gruntwork-io/runbooks/issues"

function buildCliMenuItems(): MenuItemConstructorOptions[] {
  return [
    {
      label: "Install 'runbooks' command in PATH",
      click: async () => {
        try {
          const status = await checkCliInstall()
          if (status.installed) {
            dialog.showMessageBox({
              type: "info",
              title: "CLI Already Installed",
              message: `The 'runbooks' command is already installed at ${status.symlinkPath}.`,
            })
            return
          }
          const result = await installCli()
          dialog.showMessageBox({
            type: "info",
            title: "CLI Installed",
            message: `The 'runbooks' command was installed successfully.`,
            detail: `You can now run 'runbooks' from any terminal.\nInstalled at: ${result.symlinkPath}`,
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          // User cancelled the admin dialog — do nothing
          if (message.includes("User canceled") || message.includes("dismissed")) return
          dialog.showErrorBox(
            "CLI Installation Failed",
            `Could not install the 'runbooks' command:\n\n${message}`,
          )
        }
      },
    },
    {
      label: "Uninstall 'runbooks' command from PATH",
      click: async () => {
        try {
          const status = await checkCliInstall()
          if (!status.installed) {
            dialog.showMessageBox({
              type: "info",
              title: "CLI Not Installed",
              message: "The 'runbooks' command is not currently installed.",
            })
            return
          }
          await uninstallCli()
          dialog.showMessageBox({
            type: "info",
            title: "CLI Uninstalled",
            message: "The 'runbooks' command has been removed from your PATH.",
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          if (message.includes("User canceled") || message.includes("dismissed")) return
          dialog.showErrorBox(
            "CLI Uninstall Failed",
            `Could not uninstall the 'runbooks' command:\n\n${message}`,
          )
        }
      },
    },
  ]
}

function buildTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  // ---- macOS app menu ----
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Preferences…",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            getMainWindow()?.webContents.send("menu:preferences")
          },
        },
        { type: "separator" },
        ...buildCliMenuItems(),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    })
  }

  // ---- File ----
  template.push({
    label: "File",
    submenu: [
      {
        label: "Open Runbook…",
        accelerator: "CmdOrCtrl+O",
        click: async () => {
          const win = getMainWindow()
          if (!win) return
          const result = await dialog.showOpenDialog(win, {
            properties: ["openFile", "openDirectory"],
            defaultPath: runbookConfig.localPath
              ? path.dirname(runbookConfig.localPath)
              : undefined,
            filters: [
              { name: "Runbook files", extensions: ["mdx", "md"] },
              { name: "All Files", extensions: ["*"] },
            ],
          })
          if (!result.canceled && result.filePaths.length > 0) {
            win.webContents.send("file:open-runbook", { path: result.filePaths[0] })
          }
        },
      },
      {
        label: "Open from URL…",
        accelerator: "CmdOrCtrl+Shift+O",
        click: () => {
          const win = getMainWindow()
          if (!win) return
          win.webContents.send("menu:open-url-prompt")
        },
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  })

  // ---- Edit ----
  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  })

  // ---- View ----
  template.push({
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { role: "resetZoom" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  })

  // ---- Window ----
  template.push({
    label: "Window",
    submenu: isMac
      ? [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" },
          { type: "separator" },
          { role: "window" },
        ]
      : [{ role: "minimize" }, { role: "close" }],
  })

  // ---- Help ----
  template.push({
    label: "Help",
    submenu: [
      {
        label: "Learn More",
        click: () => shell.openExternal(DOCS_URL),
      },
      {
        label: "Report Issue",
        click: () => shell.openExternal(ISSUES_URL),
      },
      // On non-macOS, CLI items go in the Help menu
      ...(!isMac ? [
        { type: "separator" as const },
        ...buildCliMenuItems(),
      ] : []),
    ],
  })

  return template
}

/** Build and set the application menu. Call once on app ready. */
export function setupApplicationMenu(): void {
  const menu = Menu.buildFromTemplate(buildTemplate())
  Menu.setApplicationMenu(menu)
}
