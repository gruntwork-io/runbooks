/**
 * Native application menu.
 *
 * Builds a platform-appropriate menu bar with standard edit/view/window items
 * plus app-specific actions (Open Runbook, docs links, etc.).
 */
import * as path from "path"
import { app, Menu, dialog, shell, type MenuItemConstructorOptions } from "electron"
import type { FindAction } from "../shared/channels.ts"
import { getMainWindow } from "./window.ts"
import { installCliWithDialog, uninstallCliWithDialog } from "./cli-install-dialogs.ts"
import { runbookConfig } from "./ipc/runtime.ts"
import { closeRunbook } from "./ipc/watch.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("menu")

const isMac = process.platform === "darwin"

const DOCS_URL = "https://docs.gruntwork.io/runbooks"
const ISSUES_URL = "https://github.com/gruntwork-io/runbooks/issues"

/** Open a fixed URL in the user's default browser. */
function openExternal(url: string): void {
  shell.openExternal(url).catch((err: unknown) => {
    log.error("Failed to open external URL:", err)
  })
}

/** Ask for a runbook file or directory and open it in the main window. */
async function openRunbookFromDialog(): Promise<void> {
  const win = getMainWindow()
  if (!win) return
  try {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "openDirectory"],
      ...(runbookConfig.localPath ? { defaultPath: path.dirname(runbookConfig.localPath) } : {}),
      filters: [
        { name: "Runbook files", extensions: ["mdx", "md"] },
        { name: "All Files", extensions: ["*"] },
      ],
    })
    if (!result.canceled && result.filePaths.length > 0) {
      win.webContents.send("file:open-runbook", { path: result.filePaths[0] })
    }
  } catch (err: unknown) {
    log.error("Open Runbook dialog failed:", err)
  }
}

function buildCliMenuItems(): MenuItemConstructorOptions[] {
  return [
    {
      label: "Install 'runbooks' command in PATH",
      click: () => void installCliWithDialog(),
    },
    {
      label: "Uninstall 'runbooks' command from PATH",
      click: () => void uninstallCliWithDialog(),
    },
  ]
}

/** Open the renderer's find bar, or move it to the next or previous match. */
function sendFind(action: FindAction): void {
  getMainWindow()?.webContents.send("menu:find", { action })
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
        click: () => void openRunbookFromDialog(),
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
      {
        label: "Close Runbook",
        accelerator: "CmdOrCtrl+Shift+W",
        click: () => closeRunbook(),
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
      { type: "separator" },
      { id: "find", label: "Find…", accelerator: "CmdOrCtrl+F", click: () => sendFind("open") },
      {
        id: "find-next",
        label: "Find Next",
        accelerator: "CmdOrCtrl+G",
        click: () => sendFind("next"),
      },
      {
        id: "find-previous",
        label: "Find Previous",
        accelerator: "Shift+CmdOrCtrl+G",
        click: () => sendFind("previous"),
      },
    ],
  })

  // ---- View ----
  template.push({
    label: "View",
    submenu: [
      {
        id: "command-palette",
        label: "Command Palette…",
        accelerator: "CmdOrCtrl+K",
        click: () => getMainWindow()?.webContents.send("menu:open-command-palette"),
      },
      { type: "separator" },
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
        click: () => openExternal(DOCS_URL),
      },
      {
        label: "Report Issue",
        click: () => openExternal(ISSUES_URL),
      },
      // On non-macOS, CLI items go in the Help menu
      ...(!isMac ? [{ type: "separator" as const }, ...buildCliMenuItems()] : []),
    ],
  })

  return template
}

/** Build and set the application menu. Call once on app ready. */
export function setupApplicationMenu(): void {
  const menu = Menu.buildFromTemplate(buildTemplate())
  Menu.setApplicationMenu(menu)
}
