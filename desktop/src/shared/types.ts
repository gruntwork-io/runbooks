// ============================================================================
// Shared types for Runbooks Desktop
// ============================================================================

// --- Runbook types ---

/** Front matter parsed from YAML header in runbook.mdx */
export interface RunbookFrontMatter {
  title?: string
  description?: string
  [key: string]: unknown
}

/** A loaded runbook ready to render */
export interface RunbookData {
  /** Raw MDX content (with front matter stripped) */
  content: string
  /** Parsed front matter */
  frontMatter: RunbookFrontMatter
  /** Absolute path to the runbook folder */
  folderPath: string
  /** Absolute path to the runbook.mdx file */
  filePath: string
}

// --- Recent runbooks ---

export interface RecentRunbook {
  path: string
  name: string
  lastUsed: string // ISO date
}

// --- IPC channel names ---

export const IPC_CHANNELS = {
  LOAD_RUNBOOK: 'runbook:load',
  READ_FILE: 'runbook:read-file',
  EXECUTE_SCRIPT: 'runbook:execute-script',
  CANCEL_SCRIPT: 'runbook:cancel-script',
  SCRIPT_OUTPUT: 'runbook:script-output',
  SCRIPT_EXIT: 'runbook:script-exit',
  SELECT_FOLDER: 'runbook:select-folder',
  GET_RECENT_RUNBOOKS: 'runbook:get-recent-runbooks',
  ADD_RECENT_RUNBOOK: 'runbook:add-recent-runbook',
} as const

// --- IPC request/response types ---

export interface LoadRunbookResponse {
  runbook: RunbookData
}

export interface ReadFileRequest {
  /** Path relative to the runbook folder */
  relativePath: string
  /** Absolute path to the runbook folder */
  runbookFolder: string
}

export interface ReadFileResponse {
  content: string
  language: string
}

export interface ExecuteScriptRequest {
  /** Unique ID for this execution (to match output/exit events) */
  executionId: string
  /** The script content to execute */
  script: string
  /** Working directory (runbook folder) */
  cwd: string
  /** Environment variables to pass */
  env?: Record<string, string>
}

export interface ScriptOutputEvent {
  executionId: string
  data: string
}

export interface ScriptExitEvent {
  executionId: string
  exitCode: number | null
  signal: string | null
}
