import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { IpcChannelMap, IpcEventMap, InvokeChannel, EventChannel } from "../shared/channels.ts"

// Channels the renderer may use. `satisfies Record<InvokeChannel, true>` (and
// `Record<EventChannel, true>` below) makes tsc fail if a channel declared in
// channels.ts is missing here or an unknown one is listed, so every channel
// added there needs a matching entry.
const INVOKE_CHANNELS = {
  "runbook:get": true, "runbook:open-remote": true, "runbook:executables": true,
  "session:get": true, "session:reset": true, "session:set-env": true,
  "exec:run": true, "exec:cancel": true,
  "boilerplate:variables": true, "boilerplate:render": true, "boilerplate:render-inline": true,
  "aws:validate": true, "aws:profiles": true, "aws:sso-start": true, "aws:sso-roles": true, "aws:sso-poll": true, "aws:sso-complete": true,
  "aws:env-credentials": true, "aws:env-credentials-confirm": true, "aws:profile-auth": true, "aws:check-region": true,
  "google:validate-credentials": true, "google:oauth-available": true, "google:oauth-start": true,
  "google:oauth-poll": true, "google:oauth-cancel": true,
  "google:gcloud-configurations": true, "google:gcloud-auth": true, "google:env-credentials": true,
  "google:env-credentials-confirm": true, "google:projects": true, "google:set-project": true, "google:check-project": true,
  "google:credential-committed": true,
  "github:validate": true, "github:oauth-start": true, "github:oauth-poll": true, "github:env-credentials": true,
  "github:cli-credentials": true, "github:orgs": true, "github:repos": true, "github:refs": true, "github:labels": true,
  "gitlab:validate": true, "gitlab:env-credentials": true, "gitlab:cli-credentials": true, "gitlab:labels": true, "gitlab:enumerate-hosts": true,
  "gitlab:host-picked": true,
  "vcs:cli-status": true, "vcs:invalidate-cache": true, "vcs:apply-git-schannel": true,
  "git:clone": true, "git:local-repo": true, "git:push": true, "git:init-default-branch": true, "git:pull-request": true, "git:merge-request": true, "git:delete-branch": true,
  "workspace:tree": true, "workspace:dirs": true, "workspace:file": true, "workspace:changes": true,
  "workspace:register": true, "workspace:set-active": true,
  "generated-files:check": true, "generated-files:delete": true,
  "cli:check-install": true, "cli:install": true,
  "file:read": true,
  "watch:subscribe": true,
  "telemetry:config": true,
  "native:open-external": true, "native:show-open-dialog": true, "native:open-runbook-dialog": true, "native:close-runbook": true, "native:get-cli-config": true,
  "native:set-theme": true,
} satisfies Record<InvokeChannel, true>

const EVENT_CHANNELS = {
  "exec:log": true, "exec:log-file": true, "exec:status": true, "exec:outputs": true, "exec:files-captured": true,
  "watch:file-change": true,
  "git:clone-progress": true,
  "git:log": true, "git:status": true, "git:pr-result": true, "git:outputs": true, "git:error": true,
  "file:open-runbook": true,
  "menu:open-url-prompt": true,
  "menu:close-runbook": true,
  "menu:preferences": true,
  "registry:updated": true,
  "vcs:session-changed": true,
} satisfies Record<EventChannel, true>

const ALLOWED_INVOKE_CHANNELS: Set<string> = new Set(Object.keys(INVOKE_CHANNELS))
const ALLOWED_EVENT_CHANNELS: Set<string> = new Set(Object.keys(EVENT_CHANNELS))

export interface TypedApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: IpcChannelMap[C]["params"] extends void ? [] : [IpcChannelMap[C]["params"]]): Promise<IpcChannelMap[C]["result"]>
  on<C extends EventChannel>(channel: C, callback: (payload: IpcEventMap[C]) => void): () => void
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
} satisfies Record<keyof TypedApi, unknown>)
