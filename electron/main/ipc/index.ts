/**
 * IPC handler registration.
 *
 * Aggregates all handler modules and registers them with Electron's ipcMain.
 * Call registerAllIpcHandlers() once during app startup, before creating any
 * BrowserWindow instances.
 *
 * Handlers may let `runtime.runPromise(...)` reject: importing this module
 * installs installIpcErrorNormalization() (ipc-error.ts), which turns every
 * rejection into a clean message for the renderer. Installing it here, at
 * import time, means it runs before any handler is registered: before
 * registerAllIpcHandlers() and before main/index.ts, which imports this
 * module, registers its native handlers.
 */
import { ipcMain } from "electron"
import { Effect } from "effect"
import { ProcessSpawner } from "../../../src/services/ProcessSpawner.ts"
import { installIpcErrorNormalization } from "./ipc-error.ts"
import { runtime } from "./runtime.ts"
import { registerSessionHandlers } from "./session.ts"
import { registerRunbookHandlers } from "./runbook.ts"
import { registerExecHandlers } from "./exec.ts"
import { registerBoilerplateHandlers } from "./boilerplate.ts"
import { registerAwsHandlers } from "./aws.ts"
import { registerGoogleHandlers } from "./google.ts"
import { registerGitHubHandlers } from "./github.ts"
import { registerGitLabHandlers } from "./gitlab.ts"
import { registerGitHandlers } from "./git.ts"
import { registerWorkspaceHandlers } from "./workspace.ts"
import { registerFileHandlers } from "./files.ts"
import { registerWatchHandlers } from "./watch.ts"
import { registerTelemetryHandlers } from "./telemetry.ts"
import { registerThemeHandlers } from "./theme.ts"
import { withVcs } from "./vcs-tristate.ts"
import { errorMessage } from "../../../src/errors/message.ts"

installIpcErrorNormalization(ipcMain)

// Channel contracts documented in electron/shared/channels.ts.
function registerVcsStatusHandler(): void {
  ipcMain.handle("vcs:cli-status", () => withVcs((vcs) => vcs.cliStatus()))
  ipcMain.handle("vcs:invalidate-cache", async () => {
    await withVcs((vcs) => vcs.invalidateCache())
    return { ok: true as const }
  })
  // The ONLY consented write Runbooks ever offers: explicit button
  // press in the renderer → `git config --global http.sslBackend schannel`.
  // git config, never credentials; never silent.
  ipcMain.handle("vcs:apply-git-schannel", async () => {
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ProcessSpawner
          const proc = yield* spawner.spawn("git", [
            "config",
            "--global",
            "http.sslBackend",
            "schannel",
          ])
          return yield* proc.exitCode
        }),
      )
      if (result === 0) {
        await withVcs((vcs) => vcs.invalidateCache()) // re-probe sslBackend next time
        return { ok: true }
      }
      return { ok: false, error: `git config exited with code ${result}` }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
}

export function registerAllIpcHandlers(): void {
  registerSessionHandlers()
  registerRunbookHandlers()
  registerExecHandlers()
  registerBoilerplateHandlers()
  registerAwsHandlers()
  registerGoogleHandlers()
  registerGitHubHandlers()
  registerGitLabHandlers()
  registerGitHandlers()
  registerWorkspaceHandlers()
  registerFileHandlers()
  registerWatchHandlers()
  registerTelemetryHandlers()
  registerThemeHandlers()
  registerVcsStatusHandler()
}
