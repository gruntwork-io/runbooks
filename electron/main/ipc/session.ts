/**
 * IPC handlers for session management.
 *
 * Bridges Electron ipcMain to the SessionManager domain module.
 * All handlers are process-local and trusted -- no token validation needed.
 */
import fs from "fs"
import path from "path"
import { ipcMain } from "electron"
import { runtime, sessionManager, cliWorkingDir } from "./runtime.ts"

export function registerSessionHandlers(): void {
  ipcMain.handle(
    "session:create",
    async (_event, params: { workingDir: string }) => {
      // --working-dir on the CLI overrides the renderer-supplied value so that
      // E2E tests can isolate generated files in a temp dir.
      const input = cliWorkingDir ?? params.workingDir
      // Resolve symlinks so session.workingDir matches paths returned by
      // fs.realpath elsewhere in the pipeline (macOS /var -> /private/var).
      // Without this, template outputs under os.tmpdir() fail containment
      // checks because one side is realpath'd and the other isn't.
      let resolved = path.resolve(input)
      try {
        resolved = fs.realpathSync(resolved)
      } catch {
        // Path may not exist yet — fall back to the lexical resolution.
      }
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
