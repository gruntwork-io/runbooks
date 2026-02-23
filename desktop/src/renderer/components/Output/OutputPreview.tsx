import React from 'react'
import type { RenderResponse } from '../../../shared/types'

interface OutputPreviewProps {
  result: RenderResponse
}

export function OutputPreview({ result }: OutputPreviewProps) {
  return (
    <div className="rounded-lg border border-neutral-200 overflow-hidden">
      <div className="px-4 py-2 bg-neutral-50 border-b border-neutral-200 flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          Generated Files
        </span>
        <span className="text-xs text-neutral-400">
          {result.filesWritten.length} file(s) written to {result.outputFolder}
        </span>
      </div>
      <div className="p-2 max-h-48 overflow-y-auto">
        {result.filesWritten.length === 0 ? (
          <div className="text-sm text-neutral-400 p-2">No files generated.</div>
        ) : (
          <ul className="space-y-0.5">
            {result.filesWritten.map((file) => (
              <li
                key={file}
                className="flex items-center gap-2 px-2 py-1 text-sm text-neutral-600 rounded hover:bg-neutral-50"
              >
                <svg
                  className="w-4 h-4 text-neutral-400 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                  />
                </svg>
                <span className="font-mono text-xs">{file}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
