/**
 * IPC handlers for session management.
 *
 * Bridges Electron ipcMain to the SessionManager domain module.
 * All handlers are process-local and trusted -- no token validation needed.
 */
import { ipcMain } from "electron"
import { runtime, sessionManager, vcsSessionMeta } from "./runtime.ts"

export function registerSessionHandlers(): void {
  ipcMain.handle("session:join", async () => {
    return runtime.runPromise(sessionManager.joinSession())
  })

  ipcMain.handle("session:get", async () => {
    return runtime.runPromise(sessionManager.getMetadata())
  })

  ipcMain.handle("session:reset", async () => {
    const result = await runtime.runPromise(sessionManager.resetSession())
    // The reset restores the initial env, dropping every credential an auth
    // block wrote — drop their host bindings with them.
    vcsSessionMeta.clear()
    return result
  })

  ipcMain.handle("session:delete", async () => {
    sessionManager.deleteSession()
    return { ok: true as const }
  })

  ipcMain.handle(
    "session:set-env",
    async (_event, params: { env: Record<string, string> }) => {
      return runtime.runPromise(sessionManager.appendToEnv(params.env))
    },
  )
}
