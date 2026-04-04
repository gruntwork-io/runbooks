# IPC API Specification

Replaces all HTTP routes from `api/server.go` with Electron IPC channels.

## Channel Naming Convention

`domain:action` (e.g., `session:create`, `exec:run`, `aws:validate`)

- **invoke** channels: request/response (replaces REST GET/POST/DELETE)
- **send** channels: server-to-client events (replaces SSE streams)

## Complete API

### Runbook

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `runbook:get` | invoke | `GET /api/runbook` | `{ isWatchMode, useRegistry, remoteSourceURL }` | `{ content, localPath, isWatchMode, useRegistry, remoteSourceURL }` |
| `runbook:executables` | invoke | `GET /api/runbook/executables` | none | `Executable[]` |
| `runbook:assets` | invoke | `GET /runbook-assets/*` | `{ filepath }` | `{ data: Buffer, mimeType }` |

### Session

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `session:create` | invoke | `POST /api/session` | `{ workingDir }` | `{ token }` |
| `session:join` | invoke | `POST /api/session/join` | none | `{ token }` |
| `session:get` | invoke | `GET /api/session` | none | `SessionMetadata` |
| `session:reset` | invoke | `POST /api/session/reset` | none | `{ ok }` |
| `session:delete` | invoke | `DELETE /api/session` | none | `{ ok }` |
| `session:set-env` | invoke | `PATCH /api/session/env` | `{ env: Record<string, string> }` | `{ ok }` |

**Note**: Session tokens are managed internally by the main process. The renderer doesn't need to send Bearer tokens since IPC is process-local and trusted.

### Execution

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `exec:run` | invoke | `POST /api/exec` | `ExecRequest` | `{ status, exitCode }` |
| `exec:log` | send | SSE `event: log` | - | `{ line, timestamp, replace? }` |
| `exec:status` | send | SSE `event: status` | - | `{ status, exitCode }` |
| `exec:outputs` | send | SSE `event: outputs` | - | `{ outputs: Record<string, string> }` |
| `exec:files-captured` | send | SSE `event: files_captured` | - | `{ files, count, fileTree }` |
| `exec:error` | send | SSE `event: error` | - | `{ message, details }` |

**Streaming pattern**: `exec:run` is invoked, starts execution. During execution, the main process sends `exec:log`, `exec:outputs`, `exec:files-captured` events. When done, `exec:status` is sent and the invoke promise resolves.

### Boilerplate

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `boilerplate:variables` | invoke | `POST /api/boilerplate/variables` | `{ templatePath?, boilerplateContent? }` | `BoilerplateConfig` |
| `boilerplate:render` | invoke | `POST /api/boilerplate/render` | `RenderRequest` | `RenderResponse` |
| `boilerplate:render-inline` | invoke | `POST /api/boilerplate/render-inline` | `RenderInlineRequest` | `RenderInlineResponse` |

### AWS Authentication

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `aws:validate` | invoke | `POST /api/aws/validate` | `{ accessKeyId, secretAccessKey, sessionToken?, region }` | `{ valid, accountId, accountName, arn, error? }` |
| `aws:profiles` | invoke | `GET /api/aws/profiles` | none | `ProfileInfo[]` |
| `aws:sso-start` | invoke | `POST /api/aws/sso/start` | `{ startUrl, region }` | `{ verificationUri, userCode, deviceCode, clientId, clientSecret }` |
| `aws:sso-roles` | invoke | `POST /api/aws/sso/roles` | `{ accessToken, accountId }` | `{ roles }` |
| `aws:sso-poll` | invoke | `POST /api/aws/sso/poll` | `{ clientId, clientSecret, deviceCode }` | `{ accessToken?, pending? }` |
| `aws:sso-complete` | invoke | `POST /api/aws/sso/complete` | `{ accessToken, accountId, roleName, region }` | `{ credentials }` |
| `aws:env-credentials` | invoke | `GET /api/aws/env-credentials` | none | `{ detected, credentials? }` |
| `aws:env-credentials-confirm` | invoke | `POST /api/aws/env-credentials/confirm` | none | `{ ok }` |
| `aws:profile-auth` | invoke | `POST /api/aws/profile` | `{ profileName }` | `{ credentials }` |
| `aws:check-region` | invoke | `POST /api/aws/check-region` | `{ region }` | `{ enabled }` |

### GitHub Authentication

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `github:validate` | invoke | `POST /api/github/validate` | `{ token }` | `{ valid, user }` |
| `github:oauth-start` | invoke | `POST /api/github/oauth/start` | `{ clientId, scopes }` | `{ deviceCode, userCode, verificationUri, interval }` |
| `github:oauth-poll` | invoke | `POST /api/github/oauth/poll` | `{ clientId, deviceCode }` | `{ token?, pending? }` |
| `github:env-credentials` | invoke | `POST /api/github/env-credentials` | none | `{ detected, token? }` |
| `github:cli-credentials` | invoke | `POST /api/github/cli-credentials` | none | `{ detected, token? }` |
| `github:orgs` | invoke | `GET /api/github/orgs` | none | `GitHubOrg[]` |
| `github:repos` | invoke | `GET /api/github/repos` | `{ org }` | `GitHubRepo[]` |
| `github:refs` | invoke | `GET /api/github/refs` | `{ owner, repo }` | `GitHubRef[]` |
| `github:labels` | invoke | `GET /api/github/labels` | `{ owner, repo }` | `string[]` |

### Git Operations

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `git:clone` | invoke | `POST /api/git/clone` | `GitCloneRequest` | `{ fileCount, absolutePath, relativePath }` |
| `git:clone-progress` | send | SSE clone events | - | `{ line, timestamp }` |
| `git:push` | invoke | `POST /api/git/push` | `{ worktreePath, remote, branch }` | `{ ok }` |
| `git:push-progress` | send | SSE push events | - | `{ line, timestamp }` |
| `git:pull-request` | invoke | `POST /api/git/pull-request` | `PullRequestRequest` | `{ url, number }` |
| `git:delete-branch` | invoke | `DELETE /api/git/branch` | `{ worktreePath, branch }` | `{ ok }` |

### TF/OpenTofu - DROPPED

See [electron-rewrite-dropped.md](./electron-rewrite-dropped.md). No `tf:parse` channel.

### Workspace

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `workspace:tree` | invoke | `GET /api/workspace/tree` | `{ worktreePath, subpath? }` | `WorkspaceTreeNode[]` |
| `workspace:dirs` | invoke | `GET /api/workspace/dirs` | `{ worktreePath }` | `string[]` |
| `workspace:file` | invoke | `GET /api/workspace/file` | `{ worktreePath, filePath }` | `WorkspaceFileResponse` |
| `workspace:changes` | invoke | `GET /api/workspace/changes` | `{ worktreePath }` | `{ changes, gitInfo }` |
| `workspace:register` | invoke | `POST /api/workspace/register` | `{ worktreePath }` | `{ ok }` |
| `workspace:set-active` | invoke | `POST /api/workspace/set-active` | `{ worktreePath }` | `{ ok }` |

### Generated Files

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `generated-files:check` | invoke | `GET /api/generated-files/check` | none | `{ hasFiles, fileCount }` |
| `generated-files:delete` | invoke | `DELETE /api/generated-files/delete` | none | `{ ok }` |

### File Operations

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `file:read` | invoke | `POST /api/file` | `{ path }` | `File` |

### Watch Mode

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `watch:subscribe` | invoke | `GET /api/watch` (SSE) | none | `{ ok }` |
| `watch:file-change` | send | SSE `event: file-change` | - | `{ type: 'reload' }` |

### Telemetry

| Channel | Direction | Replaces | Params | Returns |
|---------|-----------|----------|--------|---------|
| `telemetry:config` | invoke | `GET /api/telemetry/config` | none | `{ enabled, token? }` |

### Native (Electron-only, no Go equivalent)

| Channel | Direction | Purpose | Params | Returns |
|---------|-----------|---------|--------|---------|
| `native:open-external` | invoke | Open URL in browser (OAuth) | `{ url }` | `{ ok }` |
| `native:show-open-dialog` | invoke | Native file/folder picker | `{ properties, filters? }` | `{ filePaths }` |
| `native:get-app-info` | invoke | App version, platform info | none | `{ version, platform, arch }` |

## Preload Script Structure

```typescript
// electron/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // Request/response
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),

  // Subscribe to server-sent events
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args)
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },

  // One-time event listener
  once: (channel: string, callback: (...args: unknown[]) => void) => {
    ipcRenderer.once(channel, (_event, ...args) => callback(...args))
  },
})
```

## Type Safety

All IPC channels are typed via `electron/shared/channels.ts`:

```typescript
// electron/shared/channels.ts
export interface IpcChannelMap {
  'runbook:get': { params: RunbookGetParams; result: RunbookGetResult }
  'session:create': { params: SessionCreateParams; result: SessionCreateResult }
  'exec:run': { params: ExecRequest; result: ExecStatusEvent }
  // ... all channels
}

export interface IpcEventMap {
  'exec:log': ExecLogEvent
  'exec:status': ExecStatusEvent
  'exec:outputs': BlockOutputsEvent
  'exec:files-captured': FilesCapturedEvent
  'watch:file-change': { type: 'reload' }
  'git:clone-progress': { line: string; timestamp: string }
  // ... all events
}
```

This enables type-safe IPC calls in both main and renderer processes.
