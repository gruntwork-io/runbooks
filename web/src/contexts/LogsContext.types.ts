import { createContext } from 'react'
import type { LogEntry } from '@/hooks/useApiExec'

export interface LogsContextType {
  /** Register or update logs for a specific block (component) */
  registerLogs: (blockId: string, logs: LogEntry[]) => void
  /** Get all collected logs keyed by blockId */
  getAllLogs: () => Map<string, LogEntry[]>
  /** Check if any logs exist */
  hasLogs: boolean
  /** Clear all logs (useful when loading a new runbook) */
  clearLogs: () => void
}

export const LogsContext = createContext<LogsContextType | undefined>(undefined)

