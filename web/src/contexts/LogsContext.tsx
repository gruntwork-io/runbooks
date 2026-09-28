import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LogEntry } from '@/hooks/useApiExec'
import { LogsContext } from './LogsContext.types'

interface LogsProviderProps {
  children: ReactNode
}

/**
 * Provider component that aggregates logs from all Command and Check components.
 * Enables the header to download all logs as a zip file.
 */
export function LogsProvider({ children }: LogsProviderProps) {
  // Store logs keyed by blockId. This lives in a ref, not state: blocks register
  // a new array for every streamed line, and holding it in state would re-render
  // every useLogs() consumer (each Command/Check block and the Header) per line.
  const logsRef = useRef<Map<string, LogEntry[]>>(new Map())
  // At least one block has at least one log entry. The only reactive value.
  const [hasLogs, setHasLogs] = useState(false)

  const registerLogs = useCallback((blockId: string, logs: LogEntry[]) => {
    logsRef.current.set(blockId, logs)
    // Setting the same boolean is a no-op, so consumers only re-render when
    // hasLogs actually flips.
    setHasLogs(Array.from(logsRef.current.values()).some(l => l.length > 0))
  }, [])

  // Read at call time (Header's download handlers), so it always sees the
  // latest logs even though registering them doesn't re-render anyone.
  const getAllLogs = useCallback(() => {
    return new Map(logsRef.current)
  }, [])

  const clearLogs = useCallback(() => {
    logsRef.current = new Map()
    setHasLogs(false)
  }, [])

  const value = useMemo(
    () => ({ registerLogs, getAllLogs, hasLogs, clearLogs }),
    [registerLogs, getAllLogs, hasLogs, clearLogs]
  )

  return (
    <LogsContext.Provider value={value}>
      {children}
    </LogsContext.Provider>
  )
}
