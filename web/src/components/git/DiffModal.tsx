import { useState, useEffect } from 'react'
import { X, ChevronLeft, ChevronRight, Plus, Pencil, Trash2 } from 'lucide-react'
import { DiffViewer } from './DiffViewer'
import { Button } from '../ui/button'
import { useSession } from '../../contexts/useSession'
import type { GitFileStatus } from '../../contexts/GitWorkspaceContext.types'

interface DiffModalProps {
  isOpen: boolean
  onClose: () => void
  files: GitFileStatus[]
  workspacePath: string
  initialFileIndex?: number
}

function getStatusBadge(status: GitFileStatus['status']) {
  const baseClasses = "px-2 py-0.5 rounded text-xs font-medium"
  switch (status) {
    case 'added':
      return <span className={`${baseClasses} bg-green-100 text-green-700`}>Added</span>
    case 'modified':
      return <span className={`${baseClasses} bg-amber-100 text-amber-700`}>Modified</span>
    case 'deleted':
      return <span className={`${baseClasses} bg-red-100 text-red-700`}>Deleted</span>
    case 'renamed':
      return <span className={`${baseClasses} bg-blue-100 text-blue-700`}>Renamed</span>
    default:
      return null
  }
}

export function DiffModal({ isOpen, onClose, files, workspacePath, initialFileIndex = 0 }: DiffModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(initialFileIndex)
  const [diff, setDiff] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { getAuthHeader } = useSession()

  const selectedFile = files[selectedIndex]

  // Fetch diff for selected file
  useEffect(() => {
    if (!isOpen || !selectedFile) return

    const fetchDiff = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch('/api/git/diff', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeader(),
          },
          body: JSON.stringify({
            workspacePath,
            filePath: selectedFile.path,
          }),
        })

        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || 'Failed to fetch diff')
        }

        const data = await response.json()
        setDiff(data.diff || '')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch diff')
        setDiff('')
      } finally {
        setLoading(false)
      }
    }

    fetchDiff()
  }, [isOpen, selectedFile, workspacePath, getAuthHeader])

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(initialFileIndex)
    }
  }, [isOpen, initialFileIndex])

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowLeft' && selectedIndex > 0) {
        setSelectedIndex(i => i - 1)
      } else if (e.key === 'ArrowRight' && selectedIndex < files.length - 1) {
        setSelectedIndex(i => i + 1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, files.length, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">Review Changes</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="size-5 text-gray-600" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* File list sidebar */}
          <div className="w-64 border-r border-gray-200 overflow-y-auto">
            <div className="p-2 text-xs text-gray-500 font-medium uppercase border-b border-gray-100">
              Files Changed ({files.length})
            </div>
            {files.map((file, index) => (
              <button
                key={file.path}
                onClick={() => setSelectedIndex(index)}
                className={`w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2 border-b border-gray-100 ${
                  selectedIndex === index ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''
                }`}
              >
                {file.status === 'added' && <Plus className="size-4 text-green-600 flex-shrink-0" />}
                {file.status === 'modified' && <Pencil className="size-4 text-amber-600 flex-shrink-0" />}
                {file.status === 'deleted' && <Trash2 className="size-4 text-red-600 flex-shrink-0" />}
                <span className="text-sm font-mono truncate flex-1">{file.path}</span>
              </button>
            ))}
          </div>

          {/* Diff viewer */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* File header */}
            {selectedFile && (
              <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-medium text-gray-700">
                    {selectedFile.path}
                  </span>
                  {getStatusBadge(selectedFile.status)}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedIndex(i => i - 1)}
                    disabled={selectedIndex === 0}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span className="text-sm text-gray-500">
                    {selectedIndex + 1} / {files.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedIndex(i => i + 1)}
                    disabled={selectedIndex === files.length - 1}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Diff content */}
            <div className="flex-1 overflow-auto">
              {loading ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  Loading diff...
                </div>
              ) : error ? (
                <div className="flex items-center justify-center h-full text-red-500">
                  {error}
                </div>
              ) : (
                <DiffViewer diff={diff} />
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
          <div className="text-sm text-gray-500">
            Use arrow keys to navigate between files
          </div>
          <Button onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
