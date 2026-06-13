/**
 * IPC handler registration.
 *
 * Aggregates all handler modules and registers them with Electron's ipcMain.
 * Call registerAllIpcHandlers() once during app startup, before creating any
 * BrowserWindow instances.
 */
import { ipcMain } from "electron"
import { Effect } from "effect"
import { ProcessSpawner } from "../../../src/services/ProcessSpawner.ts"
import { runtime } from "./runtime.ts"
import { registerSessionHandlers } from "./session.ts"
import { registerRunbookHandlers } from "./runbook.ts"
import { registerExecHandlers } from "./exec.ts"
import { registerBoilerplateHandlers } from "./boilerplate.ts"
import { registerAwsHandlers } from "./aws.ts"
import { registerGitHubHandlers } from "./github.ts"
import { registerGitLabHandlers } from "./gitlab.ts"
import { registerGitHandlers } from "./git.ts"
import { registerWorkspaceHandlers } from "./workspace.ts"
import { registerFileHandlers } from "./files.ts"
import { registerWatchHandlers } from "./watch.ts"
import { registerTelemetryHandlers } from "./telemetry.ts"
import { registerThemeHandlers } from "./theme.ts"
import { withVcs } from "./vcs-tristate.ts"

// Channel contracts documented in electron/shared/channels.ts.
function registerVcsStatusHandler(): void {
  ipcMain.handle("vcs:cli-status", () => withVcs((vcs) => vcs.cliStatus()))
  ipcMain.handle("vcs:invalidate-cache", async () => {
    await withVcs((vcs) =>
      Effect.zipRight(vcs.invalidateCache(), vcs.clearTransportDegraded()),
    )
    return { ok: true as const }
  })
  // The ONLY consented write Runbooks ever offers (§3.2/§8): explicit button
  // press in the renderer → `git config --global http.sslBackend schannel`.
  // git config, never credentials; never silent.
  ipcMain.handle("vcs:apply-git-schannel", async () => {
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ProcessSpawner
          const proc = yield* spawner.spawn("git", ["config", "--global", "http.sslBackend", "schannel"])
          return yield* proc.exitCode
        }),
      )
      if (result === 0) {
        await withVcs((vcs) => vcs.invalidateCache()) // re-probe sslBackend next time
        return { ok: true }
      }
      return { ok: false, error: `git config exited with code ${result}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

export function registerAllIpcHandlers(): void {
  registerSessionHandlers()
  registerRunbookHandlers()
  registerExecHandlers()
  registerBoilerplateHandlers()
  registerAwsHandlers()
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
