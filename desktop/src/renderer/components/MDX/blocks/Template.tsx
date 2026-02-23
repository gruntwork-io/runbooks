import React from 'react'

interface TemplateProps {
  id: string
  path?: string
  title?: string
  description?: string
  runbookFolder: string
  children?: React.ReactNode
  [key: string]: unknown
}

/**
 * Template block - placeholder for boilerplate template rendering.
 * In the web app, this renders forms from boilerplate.yml and generates files.
 * For the desktop prototype, we show a placeholder.
 */
export function Template({ id, path, title }: TemplateProps) {
  return (
    <div className="relative rounded-lg border border-indigo-200 bg-indigo-50 p-4 mb-4">
      <div className="flex items-start gap-3">
        <div className="text-lg text-indigo-500 w-6 text-center flex-shrink-0">
          {'\uD83D\uDCC4'}
        </div>
        <div className="flex-1">
          <div className="font-semibold text-indigo-800 text-sm">
            {title || 'Template'}
          </div>
          {path && (
            <div className="text-xs font-mono text-indigo-500 mt-0.5">{path}</div>
          )}
          <div className="text-xs text-indigo-600 mt-2">
            Template rendering is not yet supported in the desktop app prototype.
          </div>
        </div>
      </div>
      <div className="absolute top-2 right-2 text-[10px] font-mono text-indigo-400 bg-white/60 px-1 rounded">
        {id}
      </div>
    </div>
  )
}
