import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { IpcChannelMap, IpcEventMap, InvokeChannel, EventChannel } from "../shared/channels.ts"

// Derive allowlists from the channel type definitions — no manual sync needed.
const ALLOWED_INVOKE_CHANNELS: Set<string> = new Set<InvokeChannel>([
  "runbook:get", "runbook:open-remote", "runbook:executables", "runbook:assets",
  "session:create", "session:join", "session:get", "session:reset", "session:delete", "session:set-env",
  "exec:run", "exec:cancel",
  "boilerplate:variables", "boilerplate:render", "boilerplate:render-inline",
  "aws:validate", "aws:profiles", "aws:sso-start", "aws:sso-roles", "aws:sso-poll", "aws:sso-complete",
  "aws:env-credentials", "aws:env-credentials-confirm", "aws:profile-auth", "aws:check-region",
  "github:validate", "github:oauth-start", "github:oauth-poll", "github:env-credentials",
  "github:cli-credentials", "github:orgs", "github:repos", "github:refs", "github:labels",
  "git:clone", "git:push", "git:pull-request", "git:delete-branch",
  "workspace:tree", "workspace:dirs", "workspace:file", "workspace:changes",
  "workspace:register", "workspace:set-active",
  "generated-files:check", "generated-files:delete",
  "cli:check-install", "cli:install", "cli:uninstall",
  "file:read",
  "watch:subscribe",
  "telemetry:config",
  "native:open-external", "native:show-open-dialog", "native:open-runbook-dialog", "native:get-app-info", "native:get-cli-config",
])

const ALLOWED_EVENT_CHANNELS: Set<string> = new Set<EventChannel>([
  "exec:log", "exec:status", "exec:outputs", "exec:files-captured", "exec:error",
  "watch:file-change",
  "git:clone-progress", "git:push-progress",
  "file:open-runbook",
  "menu:open-url-prompt",
  "registry:updated",
])

export interface TypedApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: IpcChannelMap[C]["params"] extends void ? [] : [IpcChannelMap[C]["params"]]): Promise<IpcChannelMap[C]["result"]>
  on<C extends EventChannel>(channel: C, callback: (payload: IpcEventMap[C]) => void): () => void
  once<C extends EventChannel>(channel: C, callback: (payload: IpcEventMap[C]) => void): void
}

contextBridge.exposeInMainWorld("api", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC invoke on unknown channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
      console.warn(`Blocked IPC listener on unknown channel: ${channel}`)
      return () => {}
    }
    const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  },

  once: (channel: string, callback: (...args: unknown[]) => void) => {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
      console.warn(`Blocked IPC listener on unknown channel: ${channel}`)
      return
    }
    ipcRenderer.once(channel, (_event, ...args) => callback(...args))
  },
} satisfies Record<keyof TypedApi, unknown>)
