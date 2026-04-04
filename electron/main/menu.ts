/**
 * Native application menu.
 *
 * Builds a platform-appropriate menu bar with standard edit/view/window items
 * plus app-specific actions (Open Runbook, docs links, etc.).
 */
import { app, Menu, dialog, shell, type MenuItemConstructorOptions } from "electron"
import { getMainWindow } from "./window.ts"

const isMac = process.platform === "darwin"

const DOCS_URL = "https://docs.gruntwork.io/runbooks"
const ISSUES_URL = "https://github.com/gruntwork-io/runbooks/issues"

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
            properties: ["openFile"],
            filters: [
              { name: "Runbook files", extensions: ["mdx", "md"] },
              { name: "All Files", extensions: ["*"] },
            ],
          })
          if (!result.canceled && result.filePaths.length > 0) {
            win.webContents.send("file:open-runbook", result.filePaths[0])
          }
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
    ],
  })

  return template
}

/** Build and set the application menu. Call once on app ready. */
export function setupApplicationMenu(): void {
  const menu = Menu.buildFromTemplate(buildTemplate())
  Menu.setApplicationMenu(menu)
}
