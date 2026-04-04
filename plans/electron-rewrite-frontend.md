# Frontend Migration: fetch+SSE to Electron IPC

## Overview

The React frontend communicates with the Go backend via `fetch()` REST calls and SSE streams. In the Electron app, these are replaced with `window.api.invoke()` IPC calls and `window.api.on()` event subscriptions.

Components themselves are mostly unchanged - the changes are concentrated in hooks and contexts.

## New File: `web/src/api.d.ts`

Type declarations for the `window.api` object exposed by the preload script:

```typescript
interface RunbooksAPI {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  on(channel: string, callback: (...args: unknown[]) => void): () => void
  once(channel: string, callback: (...args: unknown[]) => void): void
}

declare global {
  interface Window {
    api: RunbooksAPI
  }
}
```

## Hook Migrations

### `useApi.ts` -> `useIpc.ts`

The base hook changes from fetch to IPC invoke:

**Before** (fetch):
```typescript
const response = await fetch(endpoint, { method, headers, body })
const data = await response.json()
```

**After** (IPC):
```typescript
const data = await window.api.invoke(channel, params)
```

Key changes:
- Remove `fullUrl` construction (no HTTP URLs)
- Remove `Content-Type` and `Authorization` headers (IPC is process-local)
- Remove `response.ok` / HTTP status code checking
- Add try/catch for IPC errors (thrown as exceptions, not HTTP codes)
- Keep: `data`, `isLoading`, `error`, `refetch`, `silentRefetch` interface
- Keep: debounce support

### `useApiExec.ts` -> `useIpcExec.ts`

SSE streaming becomes IPC event listeners:

**Before** (SSE):
```typescript
const response = await fetch('/api/exec', { method: 'POST', body, headers })
// Read response.body stream, parse SSE messages
const reader = response.body.getReader()
while (true) {
  const { done, value } = await reader.read()
  // Parse event: type\ndata: json\n\n
}
```

**After** (IPC events):
```typescript
// Subscribe to events before starting execution
const unsubLog = window.api.on('exec:log', (data) => {
  setState(prev => ({ ...prev, logs: [...prev.logs, createLogEntry(data.line, data.timestamp)] }))
})
const unsubOutputs = window.api.on('exec:outputs', (data) => {
  setState(prev => ({ ...prev, outputs: data.outputs }))
  onOutputsCaptured?.(data.outputs)
})
const unsubFiles = window.api.on('exec:files-captured', (data) => {
  onFilesCaptured?.(data)
})
const unsubStatus = window.api.on('exec:status', (data) => {
  setState(prev => ({ ...prev, status: data.status, exitCode: data.exitCode }))
})

// Start execution (resolves when done)
try {
  await window.api.invoke('exec:run', payload)
} finally {
  // Cleanup subscriptions
  unsubLog()
  unsubOutputs()
  unsubFiles()
  unsubStatus()
}
```

Key changes:
- Remove SSE message parsing (event/data format)
- Remove AbortController (IPC cancellation via separate channel or by closing listeners)
- Remove fetch error handling (replace with IPC error handling)
- Keep: ExecState interface, execute/executeByComponentId/cancel/reset API
- Keep: Zod validation of event data (defense in depth)

### `useApiGetRunbook.ts`

**Before**: `useApi<GetFileReturn>('/api/runbook')`
**After**: `useIpc<GetFileReturn>('runbook:get')`

### `useApiGetFile.ts`

**Before**: `useApi<File>('/api/file', 'POST', { path })`
**After**: `useIpc<File>('file:read', { path })`

### `useApiGetBoilerplateConfig.ts`

**Before**: `useApi<BoilerplateConfig>('/api/boilerplate/variables', 'POST', { templatePath })`
**After**: `useIpc<BoilerplateConfig>('boilerplate:variables', { templatePath })`

### `useApiBoilerplateRender.ts`

**Before**: `fetch('/api/boilerplate/render', { method: 'POST', body, headers })`
**After**: `window.api.invoke('boilerplate:render', params)`

### `useApiGeneratedFilesCheck.ts`

**Before**: `useApi<CheckResult>('/api/generated-files/check')`
**After**: `useIpc<CheckResult>('generated-files:check')`

### `useApiGeneratedFilesDelete.ts`

**Before**: `fetch('/api/generated-files/delete', { method: 'DELETE' })`
**After**: `window.api.invoke('generated-files:delete')`

### `useApiParseTfModule.ts` - DELETED

TfModule feature dropped. See [electron-rewrite-dropped.md](./electron-rewrite-dropped.md).

### `useExecutableRegistry.ts`

**Before**: `useApi<Executable[]>('/api/runbook/executables')`
**After**: `useIpc<Executable[]>('runbook:executables')`

### `useGitFileTree.ts`

**Before**: `fetch('/api/workspace/tree?path=...', { headers })`
**After**: `window.api.invoke('workspace:tree', { worktreePath, subpath })`

### `useGitFileChanges.ts`

**Before**: `fetch('/api/workspace/changes?path=...', { headers })`
**After**: `window.api.invoke('workspace:changes', { worktreePath })`

### `useFileContent.ts`

**Before**: `fetch('/api/workspace/file?path=...&worktree=...', { headers })`
**After**: `window.api.invoke('workspace:file', { worktreePath, filePath })`

### `useWatchMode.ts`

**Before**: `new EventSource('/api/watch')` (SSE connection)
**After**:
```typescript
useEffect(() => {
  window.api.invoke('watch:subscribe')
  const unsub = window.api.on('watch:file-change', () => onFileChange())
  return () => unsub()
}, [])
```

## Context Migrations

### `SessionContext.tsx`

**Before**:
```typescript
// Create session
const response = await fetch('/api/session', { method: 'POST', body })
const { token } = await response.json()
tokenRef.current = token

// Join session
const response = await fetch('/api/session/join', { method: 'POST' })
const { token } = await response.json()
tokenRef.current = token

// Auth header
const getAuthHeader = () => ({ Authorization: `Bearer ${tokenRef.current}` })
```

**After**:
```typescript
// Create session
await window.api.invoke('session:create', { workingDir })
// No token needed - main process manages session internally

// Join session
await window.api.invoke('session:join')

// Auth header - no longer needed
// All IPC calls are trusted (process-local)
```

Key change: **Remove Bearer token management entirely.** IPC is process-local and trusted. The session exists in the main process and all IPC handlers have direct access. The `getAuthHeader()` function and all `Authorization` header passing can be removed.

### `ExecutableRegistryContext.tsx`

**Before**: `useApi('/api/runbook/executables')`
**After**: `useIpc('runbook:executables')`

### `GeneratedFilesContext.tsx`

No changes needed - already receives data from hooks.

### `GitWorkTreeContext.tsx`

**Before**: `fetch('/api/workspace/register', { method: 'POST', headers, body })`
**After**: `window.api.invoke('workspace:register', { worktreePath })`

**Before**: `fetch('/api/workspace/set-active', { method: 'POST', headers, body })`
**After**: `window.api.invoke('workspace:set-active', { worktreePath })`

### `TelemetryContext.tsx`

**Before**: `useApi('/api/telemetry/config')`
**After**: `useIpc('telemetry:config')`

### Other Contexts

`ErrorReportingContext.tsx`, `LogsContext.tsx`, `RunbookContext.tsx`, `ComponentIdRegistry.tsx`, `FileTreeContext.tsx` - **No changes needed.** These manage frontend-only state and don't communicate with the backend.

## Component Changes

### MDX Block Components (mostly unchanged)

The block components (Command, Check, Template, AwsAuth, GitHubAuth, GitClone, etc.) consume hooks and don't call the API directly. Their code stays the same as long as the hook interfaces remain identical.

**Exception**: OAuth flow components that open external URLs.

### GitHubAuth - OAuth URL Opening

**Before**: `window.open(verificationUri, '_blank')` (opens in browser tab)
**After**: `window.api.invoke('native:open-external', { url: verificationUri })` (opens in system browser via Electron's `shell.openExternal`)

Same change for AwsAuth SSO verification URL.

### DirPicker - Directory Selection

**Before**: Text input where user types a path
**After**: Can use native dialog: `window.api.invoke('native:show-open-dialog', { properties: ['openDirectory'] })`

This is an enhancement, not a required change. The text input still works.

### Header Component

Minor changes to display app version from `window.api.invoke('native:get-app-info')` instead of from the runbook metadata endpoint.

## Summary of Changes by File

| File | Change Type | Effort |
|------|------------|--------|
| `hooks/useApi.ts` | **Rewrite** to `useIpc.ts` | Medium |
| `hooks/useApiExec.ts` | **Rewrite** (SSE to IPC events) | High |
| `hooks/useApiGetRunbook.ts` | Channel name change | Low |
| `hooks/useApiGetFile.ts` | Channel name change | Low |
| `hooks/useApiGetBoilerplateConfig.ts` | Channel name change | Low |
| `hooks/useApiBoilerplateRender.ts` | fetch to invoke | Low |
| `hooks/useApiGeneratedFilesCheck.ts` | Channel name change | Low |
| `hooks/useApiGeneratedFilesDelete.ts` | fetch to invoke | Low |
| `hooks/useApiParseTfModule.ts` | **Deleted** (TfModule dropped) | None |
| `hooks/useExecutableRegistry.ts` | Channel name change | Low |
| `hooks/useGitFileTree.ts` | fetch to invoke | Low |
| `hooks/useGitFileChanges.ts` | fetch to invoke | Low |
| `hooks/useFileContent.ts` | fetch to invoke | Low |
| `hooks/useWatchMode.ts` | EventSource to IPC | Medium |
| `contexts/SessionContext.tsx` | **Rewrite** (remove tokens) | Medium |
| `contexts/ExecutableRegistryContext.tsx` | Channel name change | Low |
| `contexts/GitWorkTreeContext.tsx` | fetch to invoke | Low |
| `contexts/TelemetryContext.tsx` | Channel name change | Low |
| `components/mdx/GitHubAuth/` | window.open to native:open-external | Low |
| `components/mdx/AwsAuth/` | window.open to native:open-external | Low |
| `components/mdx/GitClone/` | SSE streaming to IPC events | Medium |
| `components/mdx/GitHubPullRequest/` | SSE streaming to IPC events | Medium |
| `api.d.ts` | **New file** | Low |
| `main.tsx` | Remove SessionProvider token logic | Low |

**Total**: ~24 files modified, 1 new file. Most changes are mechanical (channel name swaps). The 3 high/medium-effort files are `useIpc.ts`, `useIpcExec.ts`, and `SessionContext.tsx`.
