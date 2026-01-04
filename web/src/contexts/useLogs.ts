import { useContext } from 'react'
import { LogsContext, type LogsContextType } from './LogsContext.types'

export function useLogs(): LogsContextType {
  const context = useContext(LogsContext)
  if (context === undefined) {
    throw new Error('useLogs must be used within a LogsProvider')
  }
  return context
}

