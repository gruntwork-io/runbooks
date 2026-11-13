/**
 * IPC handlers behind the Custom CA Certificate dialog. The setting itself
 * lives in custom-ca.ts.
 */
import * as path from "path"
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron"
import { clearCustomCa, getCustomCaStatus, setCustomCaFile } from "../custom-ca.ts"

export function registerCustomCaHandlers(): void {
  ipcMain.handle("tls:custom-ca-status", () => getCustomCaStatus())

  // Main shows the file dialog, so the file trusted is always one the user picked.
  ipcMain.handle("tls:choose-custom-ca", async (event) => {
    const current = getCustomCaStatus().path
    const options: OpenDialogOptions = {
      title: "Choose a CA Certificate",
      buttonLabel: "Trust",
      properties: ["openFile"],
      ...(current ? { defaultPath: path.dirname(current) } : {}),
      filters: [
        { name: "Certificates", extensions: ["pem", "crt", "cer", "cert"] },
        { name: "All Files", extensions: ["*"] },
      ],
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const file = result.filePaths[0]
    if (result.canceled || file === undefined) {
      return { status: getCustomCaStatus(), canceled: true as const }
    }
    return setCustomCaFile(file)
  })

  ipcMain.handle("tls:clear-custom-ca", () => clearCustomCa())
}
