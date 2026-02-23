// ============================================================================
// IPC Handlers - Bridge between Electron main process and renderer
// ============================================================================

import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { getRecentRunbooks, addRecentRunbook } from './recent-runbooks'
import { IPC_CHANNELS } from '../shared/types'
import type {
  LoadRunbookResponse,
  ReadFileRequest,
  ReadFileResponse,
  ExecuteScriptRequest,
  RunbookFrontMatter,
} from '../shared/types'

const RUNBOOK_FILE = 'runbook.mdx'

// Track running script processes for cancellation
const runningProcesses = new Map<string, ChildProcess>()

/** Parse YAML front matter from MDX content */
function parseFrontMatter(content: string): { frontMatter: RunbookFrontMatter; body: string } {
  if (!content.startsWith('---')) {
    return { frontMatter: {}, body: content }
  }

  const endMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!endMatch) {
    return { frontMatter: {}, body: content }
  }

  const yamlBlock = endMatch[1]
  const body = content.slice(endMatch[0].length)

  // Simple YAML key: value parser for front matter
  const frontMatter: RunbookFrontMatter = {}
  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/)
    if (match) {
      frontMatter[match[1]] = match[2].trim()
    }
  }

  return { frontMatter, body }
}

/** Get language from file extension */
function getLanguageFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  const langMap: Record<string, string> = {
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.py': 'python',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.json': 'json',
    '.tf': 'hcl',
    '.hcl': 'hcl',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.md': 'markdown',
    '.mdx': 'mdx',
  }
  return langMap[ext] || 'text'
}

export function registerIpcHandlers(): void {
  // Load a runbook from a folder
  ipcMain.handle(
    IPC_CHANNELS.LOAD_RUNBOOK,
    async (_event, folderPath: string): Promise<LoadRunbookResponse> => {
      try {
        const runbookPath = path.join(folderPath, RUNBOOK_FILE)

        if (!fs.existsSync(runbookPath)) {
          throw new Error(
            `No runbook.mdx found in "${folderPath}". ` +
              `Please select a folder containing a runbook.mdx file.`
          )
        }

        const rawContent = fs.readFileSync(runbookPath, 'utf-8')
        const { frontMatter, body } = parseFrontMatter(rawContent)

        return {
          runbook: {
            content: body,
            frontMatter,
            folderPath,
            filePath: runbookPath,
          },
        }
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err))
      }
    }
  )

  // Read a file relative to the runbook folder (for script source, etc.)
  ipcMain.handle(
    IPC_CHANNELS.READ_FILE,
    async (_event, args: ReadFileRequest): Promise<ReadFileResponse> => {
      const filePath = path.join(args.runbookFolder, args.relativePath)

      // Security: prevent directory traversal
      const resolved = path.resolve(filePath)
      const resolvedFolder = path.resolve(args.runbookFolder)
      if (!resolved.startsWith(resolvedFolder)) {
        throw new Error('Path traversal not allowed')
      }

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${args.relativePath}`)
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      const language = getLanguageFromExtension(filePath)

      return { content, language }
    }
  )

  // Execute a script (for Command/Check blocks)
  ipcMain.handle(
    IPC_CHANNELS.EXECUTE_SCRIPT,
    async (event, args: ExecuteScriptRequest): Promise<void> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return

      const child = spawn('bash', ['-c', args.script], {
        cwd: args.cwd,
        env: { ...process.env, ...args.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      runningProcesses.set(args.executionId, child)

      child.stdout?.on('data', (data: Buffer) => {
        window.webContents.send(IPC_CHANNELS.SCRIPT_OUTPUT, {
          executionId: args.executionId,
          data: data.toString(),
        })
      })

      child.stderr?.on('data', (data: Buffer) => {
        window.webContents.send(IPC_CHANNELS.SCRIPT_OUTPUT, {
          executionId: args.executionId,
          data: data.toString(),
        })
      })

      child.on('close', (exitCode, signal) => {
        runningProcesses.delete(args.executionId)
        window.webContents.send(IPC_CHANNELS.SCRIPT_EXIT, {
          executionId: args.executionId,
          exitCode,
          signal,
        })
      })

      child.on('error', (err) => {
        runningProcesses.delete(args.executionId)
        window.webContents.send(IPC_CHANNELS.SCRIPT_EXIT, {
          executionId: args.executionId,
          exitCode: 1,
          signal: err.message,
        })
      })
    }
  )

  // Cancel a running script
  ipcMain.handle(
    IPC_CHANNELS.CANCEL_SCRIPT,
    async (_event, executionId: string): Promise<void> => {
      const child = runningProcesses.get(executionId)
      if (child) {
        child.kill('SIGTERM')
        runningProcesses.delete(executionId)
      }
    }
  )

  // Open folder picker dialog
  ipcMain.handle(IPC_CHANNELS.SELECT_FOLDER, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Open Runbook',
      message: 'Choose a folder containing a runbook.mdx file',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Get recent runbooks
  ipcMain.handle(IPC_CHANNELS.GET_RECENT_RUNBOOKS, async () => {
    return getRecentRunbooks()
  })

  // Add a recent runbook
  ipcMain.handle(
    IPC_CHANNELS.ADD_RECENT_RUNBOOK,
    async (_event, args: { path: string; name: string }) => {
      return addRecentRunbook({
        path: args.path,
        name: args.name,
        lastUsed: new Date().toISOString(),
      })
    }
  )
}
