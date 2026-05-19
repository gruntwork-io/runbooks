import React from 'react'
import type { AppError } from '@/types/error'

interface ErrorDisplayProps {
  error: AppError
  errorDetails?: string | null
  onRetry?: () => void
  retryText?: string
  testId?: string
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  error, 
  onRetry,
  retryText = 'Try Again',
  testId = 'component-error'
}) => {
  return (
    <div data-testid={testId} className="p-6 bg-destructive-muted border border-destructive/30 rounded-lg">
      <div className="text-destructive font-semibold mb-2">Error: {error.message}</div>
      {error.details && (
        <div className="text-destructive text-sm mb-3">{error.details}</div>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-destructive text-white text-sm rounded-md hover:bg-destructive/90 transition-colors"
        >
          {retryText}
        </button>
      )}
    </div>
  )
}
