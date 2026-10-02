/**
 * IPC handlers for session management.
 *
 * Bridges Electron ipcMain to the SessionManager domain module.
 * All handlers are process-local and trusted.
 */
import { ipcMain } from "electron"
import { runtime, sessionManager, sessionPersistence, vcsSessionMeta } from "./runtime.ts"

export function registerSessionHandlers(): void {
  ipcMain.handle("session:get", async () => {
    return runtime.runPromise(sessionManager.getMetadata())
  })

  ipcMain.handle("session:reset", async () => {
    await runtime.runPromise(sessionManager.resetSession())
    // The reset restores the initial env, dropping every credential an auth
    // block wrote — drop their host bindings with them.
    vcsSessionMeta.clear()
    return { ok: true as const }
  })

  ipcMain.handle("session:set-env", async (_event, params: { env: Record<string, string> }) => {
    await runtime.runPromise(sessionManager.appendToEnv(params.env))
    return { ok: true as const }
  })

  // Rejects with a sentence for the user when the name is not allowed or is
  // another session's (see SessionPersistence.renameCurrent).
  ipcMain.handle("session:rename", async (_event, params?: { name?: unknown }) => {
    // index.ts sets this at startup, before any window can call a handler.
    const persistence = sessionPersistence
    if (!persistence) throw new Error("session persistence is not initialized")
    const requested = typeof params?.name === "string" ? params.name : ""
    return { name: await runtime.runPromise(persistence.renameCurrent(requested)) }
  })
}
