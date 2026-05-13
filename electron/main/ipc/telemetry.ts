/**
 * IPC handler for telemetry configuration.
 *
 * Returns the current telemetry configuration (enabled status and token)
 * so the renderer can initialize its own telemetry client.
 */
import { ipcMain } from "electron"
import { getConfig } from "../../../src/telemetry.ts"

export function registerTelemetryHandlers(): void {
  ipcMain.handle("telemetry:config", async () => {
    return getConfig()
  })
}
