import React from 'react'

interface LoadingDisplayProps {
  message?: string
}

export const LoadingDisplay: React.FC<LoadingDisplayProps> = ({
  message = 'Loading...'
}) => {
  return (
    <div className="p-6 bg-gray-50 border border-gray-200 rounded-lg">
      <div className="text-center text-gray-600">{message}</div>
    </div>
  )
}
