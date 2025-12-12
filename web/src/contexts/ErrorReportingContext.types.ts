import { createContext } from 'react'

export type ErrorSeverity = 'error' | 'warning'

export interface ReportedError {
  componentId: string
  componentType: string
  severity: ErrorSeverity
  message: string
}

export interface ErrorReportingContextValue {
  errors: ReportedError[]
  errorCount: number
  warningCount: number
  reportError: (error: ReportedError) => void
  clearError: (componentId: string) => void
  clearAllErrors: () => void
}

export const ErrorReportingContext = createContext<ErrorReportingContextValue | undefined>(undefined)
