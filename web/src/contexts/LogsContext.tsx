import { createContext, useContext, useCallback, useState, type ReactNode } from 'react'
import type { LogEntry } from '@/hooks/useApiExec'

// =============================================================================
// Types
// =============================================================================

interface LogsContextType {
  /** Register or update logs for a specific block (component) */
  registerLogs: (blockId: string, logs: LogEntry[]) => void
  /** Get all collected logs keyed by blockId */
  getAllLogs: () => Map<string, LogEntry[]>
  /** Check if any logs exist */
  hasLogs: boolean
  /** Clear all logs (useful when loading a new runbook) */
  clearLogs: () => void
}

// =============================================================================
// Context
// =============================================================================

const LogsContext = createContext<LogsContextType | undefined>(undefined)

// =============================================================================
// Provider
// =============================================================================

interface LogsProviderProps {
  children: ReactNode
}

/**
 * Provider component that aggregates logs from all Command and Check components.
 * Enables the header to download all logs as a zip file.
 */
export function LogsProvider({ children }: LogsProviderProps) {
  // Store logs keyed by blockId
  const [logsMap, setLogsMap] = useState<Map<string, LogEntry[]>>(new Map())

  const registerLogs = useCallback((blockId: string, logs: LogEntry[]) => {
    setLogsMap(prev => {
      // Skip update if logs haven't changed (shallow comparison of array length and reference)
      const existing = prev.get(blockId)
      if (existing === logs) {
        return prev
      }
      // Also skip if both are empty
      if (existing?.length === 0 && logs.length === 0) {
        return prev
      }
      
      const next = new Map(prev)
      next.set(blockId, logs)
      return next
    })
  }, [])

  const getAllLogs = useCallback(() => {
    return new Map(logsMap)
  }, [logsMap])

  const clearLogs = useCallback(() => {
    setLogsMap(new Map())
  }, [])

  // Calculate hasLogs: at least one block has at least one log entry
  const hasLogs = Array.from(logsMap.values()).some(logs => logs.length > 0)

  return (
    <LogsContext.Provider value={{ registerLogs, getAllLogs, hasLogs, clearLogs }}>
      {children}
    </LogsContext.Provider>
  )
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to access the logs context for registering and retrieving logs.
 */
export function useLogs(): LogsContextType {
  const context = useContext(LogsContext)
  if (context === undefined) {
    throw new Error('useLogs must be used within a LogsProvider')
  }
  return context
}

