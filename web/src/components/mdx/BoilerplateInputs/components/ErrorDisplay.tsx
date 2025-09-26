import React from 'react'

interface ErrorDisplayProps {
  error: string
  errorDetails?: string | null
  onRetry?: () => void
  retryText?: string
}

export const ErrorDisplay: React.FC<ErrorDisplayProps> = ({
  error,
  errorDetails,
  onRetry,
  retryText = 'Try Again'
}) => {
  return (
    <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
      <div className="text-red-600 font-semibold mb-2">Error: {error}</div>
      {errorDetails && (
        <div className="text-red-600 text-sm mb-3">{errorDetails}</div>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 transition-colors"
        >
          {retryText}
        </button>
      )}
    </div>
  )
}
