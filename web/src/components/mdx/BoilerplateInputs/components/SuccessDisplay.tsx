import React from 'react'

interface SuccessDisplayProps {
  message: string
  onReset: () => void
  resetText?: string
}

export const SuccessDisplay: React.FC<SuccessDisplayProps> = ({
  message,
  onReset,
  resetText = 'Generate Again'
}) => {
  return (
    <div className="p-6 bg-green-50 border border-green-200 rounded-lg">
      <div className="text-green-600 font-semibold mb-2">Success!</div>
      <div className="text-green-600 text-sm mb-3">{message}</div>
      <button
        onClick={onReset}
        className="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition-colors"
      >
        {resetText}
      </button>
    </div>
  )
}
