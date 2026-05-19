/**
 * IPC handler registration.
 *
 * Aggregates all handler modules and registers them with Electron's ipcMain.
 * Call registerAllIpcHandlers() once during app startup, before creating any
 * BrowserWindow instances.
 */
import { registerSessionHandlers } from "./session.ts"
import { registerRunbookHandlers } from "./runbook.ts"
import { registerExecHandlers } from "./exec.ts"
import { registerBoilerplateHandlers } from "./boilerplate.ts"
import { registerAwsHandlers } from "./aws.ts"
import { registerGitHubHandlers } from "./github.ts"
import { registerGitHandlers } from "./git.ts"
import { registerWorkspaceHandlers } from "./workspace.ts"
import { registerFileHandlers } from "./files.ts"
import { registerWatchHandlers } from "./watch.ts"
import { registerTelemetryHandlers } from "./telemetry.ts"
import { registerThemeHandlers } from "./theme.ts"

export function registerAllIpcHandlers(): void {
  registerSessionHandlers()
  registerRunbookHandlers()
  registerExecHandlers()
  registerBoilerplateHandlers()
  registerAwsHandlers()
  registerGitHubHandlers()
  registerGitHandlers()
  registerWorkspaceHandlers()
  registerFileHandlers()
  registerWatchHandlers()
  registerTelemetryHandlers()
  registerThemeHandlers()
}
