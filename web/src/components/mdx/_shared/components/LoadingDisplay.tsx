import React from 'react'

interface LoadingDisplayProps {
  message?: string
}

export const LoadingDisplay: React.FC<LoadingDisplayProps> = ({
  message = 'Loading...'
}) => {
  return (
    <div className="p-6 bg-muted border border-border rounded-lg">
      <div className="text-center text-muted-foreground">{message}</div>
    </div>
  )
}
