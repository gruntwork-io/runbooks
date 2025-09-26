import React from 'react'
import { Check } from 'lucide-react'

interface SuccessIndicatorProps {
  message: string
  show: boolean
}

export const SuccessIndicator: React.FC<SuccessIndicatorProps> = ({
  message,
  show
}) => {
  if (!show) return null

  return (
    <div className="fixed top-4 right-4 z-50 bg-green-500 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-in slide-in-from-right-5 duration-300">
      <Check className="w-5 h-5" />
      <span className="text-sm font-medium">{message}</span>
    </div>
  )
}
