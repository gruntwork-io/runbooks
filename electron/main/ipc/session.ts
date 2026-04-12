/**
 * IPC handlers for session management.
 *
 * Bridges Electron ipcMain to the SessionManager domain module.
 * All handlers are process-local and trusted -- no token validation needed.
 */
import path from "path"
import { ipcMain } from "electron"
import { runtime, sessionManager } from "./runtime.ts"

export function registerSessionHandlers(): void {
  ipcMain.handle(
    "session:create",
    async (_event, params: { workingDir: string }) => {
      const resolved = path.resolve(params.workingDir)
      if (resolved === path.parse(resolved).root) {
        throw new Error("workingDir must not be a filesystem root")
      }
      return runtime.runPromise(
        sessionManager.createSession(resolved),
      )
    },
  )

  ipcMain.handle("session:join", async () => {
    return runtime.runPromise(sessionManager.joinSession())
  })

  ipcMain.handle("session:get", async () => {
    return runtime.runPromise(sessionManager.getMetadata())
  })

  ipcMain.handle("session:reset", async () => {
    return runtime.runPromise(sessionManager.resetSession())
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
