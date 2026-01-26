import { X, Plus, Pencil, Trash2, FileQuestion, ChevronUp, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import type { GitFileStatus } from '../../contexts/GitWorkspaceContext.types'

interface ChangesPanelProps {
  files: GitFileStatus[]
  onClose: () => void
  onFileClick: (path: string) => void
}

function getStatusIcon(status: GitFileStatus['status']) {
  switch (status) {
    case 'added':
      return <Plus className="size-3 text-green-600" />
    case 'modified':
      return <Pencil className="size-3 text-amber-600" />
    case 'deleted':
      return <Trash2 className="size-3 text-red-600" />
    case 'untracked':
      return <FileQuestion className="size-3 text-gray-400" />
    default:
      return <Pencil className="size-3 text-gray-600" />
  }
}

function getStatusBadge(status: GitFileStatus['status']) {
  const baseClasses = "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase"
  switch (status) {
    case 'added':
      return <span className={`${baseClasses} bg-green-100 text-green-700`}>A</span>
    case 'modified':
      return <span className={`${baseClasses} bg-amber-100 text-amber-700`}>M</span>
    case 'deleted':
      return <span className={`${baseClasses} bg-red-100 text-red-700`}>D</span>
    case 'renamed':
      return <span className={`${baseClasses} bg-blue-100 text-blue-700`}>R</span>
    case 'untracked':
      return <span className={`${baseClasses} bg-gray-100 text-gray-600`}>?</span>
    default:
      return null
  }
}

export function ChangesPanel({ files, onClose, onFileClick }: ChangesPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true)

  const addedCount = files.filter(f => f.status === 'added').length
  const modifiedCount = files.filter(f => f.status === 'modified').length
  const deletedCount = files.filter(f => f.status === 'deleted').length

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-sm text-gray-700">
            {files.length} file{files.length !== 1 ? 's' : ''} changed
          </span>
          <div className="flex items-center gap-2 text-xs">
            {addedCount > 0 && (
              <span className="text-green-600">+{addedCount}</span>
            )}
            {modifiedCount > 0 && (
              <span className="text-amber-600">~{modifiedCount}</span>
            )}
            {deletedCount > 0 && (
              <span className="text-red-600">-{deletedCount}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setIsExpanded(!isExpanded)
            }}
            className="p-1 hover:bg-gray-200 rounded"
          >
            {isExpanded ? (
              <ChevronDown className="size-4 text-gray-600" />
            ) : (
              <ChevronUp className="size-4 text-gray-600" />
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="p-1 hover:bg-gray-200 rounded"
          >
            <X className="size-4 text-gray-600" />
          </button>
        </div>
      </div>

      {/* File list */}
      {isExpanded && (
        <div className="max-h-48 overflow-y-auto">
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => onFileClick(file.path)}
              className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-50 text-left border-b border-gray-100 last:border-b-0"
            >
              {getStatusBadge(file.status)}
              <span className="flex-1 font-mono text-sm text-gray-700 truncate">
                {file.path}
              </span>
              {(file.additions !== undefined || file.deletions !== undefined) && (
                <span className="text-xs">
                  {file.additions !== undefined && file.additions > 0 && (
                    <span className="text-green-600">+{file.additions}</span>
                  )}
                  {file.additions !== undefined && file.deletions !== undefined && ' '}
                  {file.deletions !== undefined && file.deletions > 0 && (
                    <span className="text-red-600">-{file.deletions}</span>
                  )}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
