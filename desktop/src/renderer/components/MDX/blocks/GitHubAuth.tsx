import React from 'react'

interface GitHubAuthProps {
  id: string
  title?: string
  description?: string
  [key: string]: unknown
}

export function GitHubAuth({ id, title, description }: GitHubAuthProps) {
  return (
    <div className="relative rounded-lg border border-neutral-200 bg-neutral-50 p-4 mb-4">
      <div className="flex items-start gap-3">
        <div className="text-lg w-6 text-center flex-shrink-0">
          {'\uD83D\uDD11'}
        </div>
        <div className="flex-1">
          <div className="font-semibold text-neutral-800 text-sm">
            {title || 'GitHub Authentication'}
          </div>
          {description && (
            <div className="text-sm text-neutral-600 mt-0.5">{description}</div>
          )}
          <div className="text-xs text-neutral-500 mt-2">
            GitHub authentication is not yet supported in the desktop app prototype.
          </div>
        </div>
      </div>
      <div className="absolute top-2 right-2 text-[10px] font-mono text-neutral-400 bg-white/60 px-1 rounded">
        {id}
      </div>
    </div>
  )
}
