/**
 * IPC behind agent access (electron/main/agent/): the setting the AI Agent
 * Access dialog changes, and the renderer's answers to the MCP server's
 * requests. The server itself lives in agent/access.ts.
 */
import { app, ipcMain } from "electron"
import { AgentAccess } from "../agent/access.ts"
import { RendererBridge } from "../agent/bridge.ts"
import { getMainWindow } from "../window.ts"
import { makeLogger } from "../logger.ts"
import { RUNBOOKS_VERSION } from "../../../src/runbooks-version.ts"
import type { AgentResponse } from "../../../src/domain/agent/protocol.ts"

const log = makeLogger("ipc:agent")

const bridge = new RendererBridge((event) => {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return false
  win.webContents.send("agent:request", event)
  return true
})

let access: AgentAccess | null = null

function getAccess(): AgentAccess {
  access ??= new AgentAccess({
    dataDir: app.getPath("userData"),
    version: RUNBOOKS_VERSION,
    bridge,
    // Tests pick another port (0 for any free one)
    ...(process.env.RUNBOOKS_AGENT_PORT ? { port: Number(process.env.RUNBOOKS_AGENT_PORT) } : {}),
    onActivity: () => getMainWindow()?.webContents.send("agent:activity"),
    onStatus: (status) => getMainWindow()?.webContents.send("agent:status-changed", status),
  })
  return access
}

/** Start the MCP server if the user left agent access on. Call once the app is ready. */
export async function initAgentAccess(): Promise<void> {
  const status = await getAccess().init()
  if (status.error) log.error(status.error)
}

/** Stop the MCP server and remove its token file. Called on quit. */
export async function stopAgentAccess(): Promise<void> {
  bridge.rejectAll("The Runbooks app is quitting.")
  await access?.stop()
}

export function registerAgentHandlers(): void {
  ipcMain.handle("agent:status", () => getAccess().status())
  ipcMain.handle("agent:update", (_event, change: { enabled?: unknown; confirmRuns?: unknown }) => {
    const update: { enabled?: boolean; confirmRuns?: boolean } = {}
    if (typeof change?.enabled === "boolean") update.enabled = change.enabled
    if (typeof change?.confirmRuns === "boolean") update.confirmRuns = change.confirmRuns
    return getAccess().update(update)
  })
  ipcMain.handle("agent:respond", (_event, response: AgentResponse) => {
    bridge.respond(response)
    return { ok: true as const }
  })
}
