/**
 * Agent access: the setting (off by default) and the MCP server it turns on.
 *
 * The setting is saved in agent-access.json in userData. While it is on, the
 * server listens on 127.0.0.1 with a token made fresh at each launch. The
 * token goes in agent-mcp-headers.json in userData (mode 0600), as the
 * request headers an MCP client sends, so a client can read it at connect
 * time (Claude Code's `headersHelper`) and keep working across launches. The
 * file is removed when access is turned off and when the app quits.
 *
 * No electron import, so Bun can test it: ipc/agent.ts passes the userData
 * path and the bridge.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import type { AgentServerStatus } from "../../../src/domain/agent/protocol.ts"
import { errorMessage } from "../../../src/errors/message.ts"
import type { AgentBridge } from "./bridge.ts"
import { startAgentServer, type RunningAgentServer } from "./server.ts"
import { createAgentMcpServer } from "./tools.ts"

const SETTING_FILE = "agent-access.json"
export const HEADERS_FILE = "agent-mcp-headers.json"
/** The port the server asks for, so a registered client finds it again next launch. */
export const DEFAULT_PORT = 47821

interface Settings {
  enabled: boolean
  confirmRuns: boolean
}

const DEFAULTS: Settings = { enabled: false, confirmRuns: true }

export interface AgentAccessOptions {
  dataDir: string
  version: string
  bridge: AgentBridge
  port?: number
  /** Each authorized request, for the window's "agent connected" indicator. */
  onActivity?: () => void
  /** The status changed (turned on or off, or failed to listen). */
  onStatus?: (status: AgentServerStatus) => void
}

export class AgentAccess {
  private settings: Settings
  private server: RunningAgentServer | null = null
  private error: string | undefined
  private readonly token = randomBytes(32).toString("base64url")

  constructor(private opts: AgentAccessOptions) {
    this.settings = this.load()
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.opts.dataDir, SETTING_FILE), "utf8"))
      return {
        enabled: raw.enabled === true,
        confirmRuns: raw.confirmRuns !== false,
      }
    } catch {
      return { ...DEFAULTS }
    }
  }

  private save(): void {
    fs.writeFileSync(path.join(this.opts.dataDir, SETTING_FILE), JSON.stringify(this.settings))
  }

  get headersFile(): string {
    return path.join(this.opts.dataDir, HEADERS_FILE)
  }

  get confirmRuns(): boolean {
    return this.settings.confirmRuns
  }

  status(): AgentServerStatus {
    const url = this.server?.url
    return {
      enabled: this.settings.enabled,
      confirmRuns: this.settings.confirmRuns,
      ...(url
        ? {
            url,
            headersFile: this.headersFile,
            claudeCommand: `claude mcp add --transport http runbooks ${url} --header "Authorization: Bearer ${this.token}"`,
          }
        : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  /** Start the server if the saved setting says so. Call once the app is ready. */
  async init(): Promise<AgentServerStatus> {
    if (this.settings.enabled) await this.start()
    return this.status()
  }

  async update(change: Partial<Settings>): Promise<AgentServerStatus> {
    this.settings = { ...this.settings, ...change }
    this.save()
    if (this.settings.enabled && !this.server) await this.start()
    if (!this.settings.enabled && this.server) await this.stop()
    if (!this.settings.enabled) this.error = undefined
    const status = this.status()
    this.opts.onStatus?.(status)
    return status
  }

  private async start(): Promise<void> {
    this.error = undefined
    try {
      this.server = await startAgentServer({
        port: this.opts.port ?? DEFAULT_PORT,
        token: this.token,
        createServer: () => createAgentMcpServer(this.opts.bridge, this.opts.version),
        ...(this.opts.onActivity ? { onAuthorizedRequest: this.opts.onActivity } : {}),
      })
      fs.writeFileSync(
        this.headersFile,
        JSON.stringify({ Authorization: `Bearer ${this.token}` }) + "\n",
        { mode: 0o600 },
      )
      // writeFileSync's mode applies only to a new file
      fs.chmodSync(this.headersFile, 0o600)
    } catch (err: unknown) {
      this.error = `Couldn't start the MCP server: ${errorMessage(err)}`
      if (this.server) await this.server.close()
      this.server = null
    }
  }

  /** Stop the server and remove the headers file. Also called on quit. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    try {
      fs.rmSync(this.headersFile, { force: true })
    } catch {}
    if (server) await server.close()
  }
}
