import React from 'react'
import { Loader2 } from 'lucide-react'

interface LoadingDisplayProps {
  message?: string
}

export const LoadingDisplay: React.FC<LoadingDisplayProps> = ({
  message = 'Loading...'
}) => {
  return (
    <div className="p-6 bg-gray-50 border border-gray-200 rounded-lg">
      <div className="flex items-center justify-center gap-3 text-gray-600">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>{message}</span>
      </div>
    </div>
  )
}
