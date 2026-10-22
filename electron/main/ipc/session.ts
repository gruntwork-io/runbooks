/**
 * IPC handlers for session management.
 *
 * Bridges Electron ipcMain to the SessionManager domain module.
 * All handlers are process-local and trusted.
 */
import { ipcMain } from "electron"
import {
  runtime,
  saveVcsSessionMeta,
  sessionManager,
  sessionPersistence,
  vcsSessionMeta,
} from "./runtime.ts"
import { switchToSession } from "./session-switch.ts"

export function registerSessionHandlers(): void {
  ipcMain.handle("session:get", async () => {
    return runtime.runPromise(sessionManager.getMetadata())
  })

  ipcMain.handle("session:reset", async () => {
    await runtime.runPromise(sessionManager.resetSession())
    // The reset restores the initial env, dropping every credential an auth
    // block wrote, so drop their host bindings with them.
    vcsSessionMeta.clear()
    saveVcsSessionMeta()
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

  ipcMain.handle("session:finish", async () => {
    const persistence = sessionPersistence
    if (!persistence) throw new Error("session persistence is not initialized")
    await runtime.runPromise(persistence.finishCurrent())
    return { ok: true as const }
  })

  ipcMain.handle("session:list", async () => {
    const persistence = sessionPersistence
    if (!persistence) throw new Error("session persistence is not initialized")
    return { sessions: await runtime.runPromise(persistence.listSessions()) }
  })

  ipcMain.handle(
    "session:switch",
    async (_event, params?: { id?: unknown; stopRunningScript?: unknown }) => {
      if (typeof params?.id !== "string") throw new Error("a session switch needs a session id")
      return switchToSession(params.id, params.stopRunningScript === true)
    },
  )

  // Rejects with a sentence for the user when the session is the open one, or
  // its directory can't be moved to the trash (see SessionPersistence.deleteSession).
  ipcMain.handle("session:delete", async (_event, params?: { id?: unknown }) => {
    const persistence = sessionPersistence
    if (!persistence) throw new Error("session persistence is not initialized")
    if (typeof params?.id !== "string") throw new Error("a session delete needs a session id")
    await runtime.runPromise(persistence.deleteSession(params.id))
    return { ok: true as const }
  })

  ipcMain.handle(
    "session:record-event",
    async (
      _event,
      params?: { sessionId?: unknown; blockId?: unknown; kind?: unknown; payload?: unknown },
    ) => {
      const persistence = sessionPersistence
      if (!persistence) throw new Error("session persistence is not initialized")
      if (typeof params?.sessionId !== "string") {
        throw new Error("a session event needs the id of its session")
      }
      await runtime.runPromise(
        persistence.recordEvent(params.sessionId, {
          blockId: params.blockId,
          kind: params.kind,
          payload: params.payload,
        }),
      )
      return { ok: true as const }
    },
  )
}
