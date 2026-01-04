import { useContext } from 'react'
import { ErrorReportingContext } from './ErrorReportingContext.types'

export function useErrorReporting() {
  const context = useContext(ErrorReportingContext)
  if (context === undefined) {
    throw new Error('useErrorReporting must be used within an ErrorReportingProvider')
  }
  return context
}
