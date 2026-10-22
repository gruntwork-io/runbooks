/**
 * Switching the window to another saved session (session:switch).
 *
 * The switch reuses how a launch resumes a session: main tells runbook:get to
 * resume the session by id (expectLaunch), then asks the renderer to open the
 * session's runbook, which loads it in that session.
 */
import * as fs from "node:fs"
import { runtime, sessionPersistence } from "./runtime.ts"
import { expectLaunch, isSessionOpen } from "./runbook.ts"
import { cancelAllExecutions, isExecutionRunning } from "./exec.ts"
import { openRunbookInWindow, type OpenRunbookPayload } from "../open-runbook.ts"
import { resolveRemoteRunbook } from "../remote.ts"
import { getMainWindow } from "../window.ts"
import { redactSecrets } from "../../../src/domain/vcs/redact.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import type { SessionSwitchResult } from "../../shared/channels.ts"

/**
 * Switch the window to saved session `id`. A remote runbook is cloned again
 * first. A running script is stopped, but only when `stopRunningScript` says
 * to: otherwise the switch stops short and says a script is running, so the
 * user can be asked. Switching to the open session does nothing.
 *
 * Throws when session storage or the main window is missing, which a call
 * from the renderer rules out.
 */
export async function switchToSession(
  id: string,
  stopRunningScript: boolean,
): Promise<SessionSwitchResult> {
  // index.ts sets this at startup, before any window can call a handler.
  const persistence = sessionPersistence
  if (!persistence) throw new Error("session persistence is not initialized")
  const saved = await runtime.runPromise(persistence.findSession(id))
  if (saved === undefined) return { status: "failed", error: "This session no longer exists." }
  if (isSessionOpen(id)) return { status: "switched" }
  if (saved.remoteSource === undefined && !fs.existsSync(saved.path)) {
    return { status: "failed", error: `This session's runbook is gone: ${saved.path}` }
  }
  if (isExecutionRunning() && !stopRunningScript) return { status: "script-running" }

  let open: OpenRunbookPayload = { path: saved.path }
  if (saved.remoteSource !== undefined) {
    try {
      const clone = await resolveRemoteRunbook(saved.remoteSource)
      open = { path: clone.localPath, remoteSource: clone.remoteSource }
    } catch (err) {
      return { status: "failed", error: redactSecrets(errorMessage(err)) }
    }
  }

  const win = getMainWindow()
  if (!win) throw new Error("there is no window to open the session in")
  // A script started while the clone ran is stopped too.
  await cancelAllExecutions()
  expectLaunch({ source: open.remoteSource ?? open.path, launchDir: undefined, sessionId: id })
  openRunbookInWindow(win, open)
  return { status: "switched" }
}
