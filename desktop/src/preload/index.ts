// ============================================================================
// Preload Script - Exposes IPC bridge to renderer via contextBridge
// ============================================================================

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  LoadRunbookResponse,
  ReadFileRequest,
  ReadFileResponse,
  ExecuteScriptRequest,
  ScriptOutputEvent,
  ScriptExitEvent,
  RecentRunbook,
} from '../shared/types'

export interface RunbooksAPI {
  loadRunbook: (folderPath: string) => Promise<LoadRunbookResponse>
  readFile: (args: ReadFileRequest) => Promise<ReadFileResponse>
  executeScript: (args: ExecuteScriptRequest) => Promise<void>
  cancelScript: (executionId: string) => Promise<void>
  onScriptOutput: (callback: (event: ScriptOutputEvent) => void) => () => void
  onScriptExit: (callback: (event: ScriptExitEvent) => void) => () => void
  selectFolder: () => Promise<string | null>
  getRecentRunbooks: () => Promise<RecentRunbook[]>
  addRecentRunbook: (args: { path: string; name: string }) => Promise<RecentRunbook[]>
}

const api: RunbooksAPI = {
  loadRunbook: (folderPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOAD_RUNBOOK, folderPath),

  readFile: (args: ReadFileRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.READ_FILE, args),

  executeScript: (args: ExecuteScriptRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXECUTE_SCRIPT, args),

  cancelScript: (executionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANCEL_SCRIPT, executionId),

  onScriptOutput: (callback: (event: ScriptOutputEvent) => void) => {
    const handler = (_event: unknown, data: ScriptOutputEvent): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SCRIPT_OUTPUT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCRIPT_OUTPUT, handler)
    }
  },

  onScriptExit: (callback: (event: ScriptExitEvent) => void) => {
    const handler = (_event: unknown, data: ScriptExitEvent): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SCRIPT_EXIT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SCRIPT_EXIT, handler)
    }
  },

  selectFolder: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER),

  getRecentRunbooks: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_RECENT_RUNBOOKS),

  addRecentRunbook: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.ADD_RECENT_RUNBOOK, args),
}

contextBridge.exposeInMainWorld('runbooks', api)
