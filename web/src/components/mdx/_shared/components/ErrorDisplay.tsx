import React from 'react'
import type { AppError } from '@/types/error'

interface ErrorDisplayProps {
  error: AppError
  testId?: string
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  error, 
  testId = 'component-error'
}) => {
  return (
    <div data-testid={testId} className="p-6 bg-destructive-muted border border-destructive/30 rounded-lg">
      <div className="text-destructive font-semibold mb-2">Error: {error.message}</div>
      {error.details && (
        <div className="text-destructive text-sm mb-3">{error.details}</div>
      )}
    </div>
  )
}
