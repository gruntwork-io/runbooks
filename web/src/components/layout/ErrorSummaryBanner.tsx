import { AlertTriangle, XCircle } from 'lucide-react'

interface ErrorSummaryBannerProps {
  errorCount: number
  warningCount: number
  className?: string
}

/**
 * A compact banner that summarizes the number of errors and warnings in a runbook.
 * Prompts users to scroll down to see them inline in each component.
 */
export function ErrorSummaryBanner({ errorCount, warningCount, className = '' }: ErrorSummaryBannerProps) {
  const totalIssues = errorCount + warningCount
  
  if (totalIssues === 0) {
    return null
  }

  // Determine banner style based on whether there are errors
  const hasErrors = errorCount > 0
  const bgColor = hasErrors ? 'bg-red-50' : 'bg-yellow-50'
  const borderColor = hasErrors ? 'border-red-200' : 'border-yellow-200'
  const textColor = hasErrors ? 'text-red-800' : 'text-yellow-800'

  return (
    <div className={`${bgColor} ${borderColor} border rounded-lg p-4 ${className}`}>
      <div className="flex items-center justify-center gap-6">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${textColor}`}>
            This runbook has issues:
          </span>
        </div>
        
        <div className="flex items-center gap-4 text-sm">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-red-700">
              <XCircle className="size-4" />
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
          {warningCount > 0 && (
            <span className="flex items-center gap-1 text-yellow-700">
              <AlertTriangle className="size-4" />
              {warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
            </span>
          )}
        </div>

        <div className={`flex items-center gap-1 text-sm ${textColor} opacity-75`}>
          Scroll down to see details.
        </div>
      </div>
    </div>
  )
}
