import React, { useState, useCallback, useMemo } from 'react'
import { ErrorReportingContext, type ReportedError } from './ErrorReportingContext.types'

interface ErrorReportingProviderProps {
  children: React.ReactNode
}

/**
 * Provider for centralized error reporting from MDX components.
 * Components can report errors/warnings, and the App can display a summary count.
 */
export function ErrorReportingProvider({ children }: ErrorReportingProviderProps) {
  const [errors, setErrors] = useState<ReportedError[]>([])

  const reportError = useCallback((error: ReportedError) => {
    setErrors(prev => {
      // Check if this component already reported an error
      const existingIndex = prev.findIndex(e => e.componentId === error.componentId)
      if (existingIndex >= 0) {
        const existing = prev[existingIndex]
        // Only update if the error actually changed - prevents infinite re-renders
        if (existing.message === error.message && 
            existing.severity === error.severity &&
            existing.componentType === error.componentType) {
          return prev // No change, return same reference to avoid re-render
        }
        // Update existing error
        const updated = [...prev]
        updated[existingIndex] = error
        return updated
      }
      // Add new error
      return [...prev, error]
    })
  }, [])

  const clearError = useCallback((componentId: string) => {
    setErrors(prev => prev.filter(e => e.componentId !== componentId))
  }, [])

  const clearAllErrors = useCallback(() => {
    setErrors([])
  }, [])

  const { errorCount, warningCount } = useMemo(() => {
    let errors_count = 0
    let warnings_count = 0
    for (const error of errors) {
      if (error.severity === 'error') {
        errors_count++
      } else {
        warnings_count++
      }
    }
    return { errorCount: errors_count, warningCount: warnings_count }
  }, [errors])

  const value = {
    errors,
    errorCount,
    warningCount,
    reportError,
    clearError,
    clearAllErrors,
  }

  return (
    <ErrorReportingContext.Provider value={value}>
      {children}
    </ErrorReportingContext.Provider>
  )
}
