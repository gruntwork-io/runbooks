/**
 * @fileoverview SingleFileViewer Component
 * 
 * Displays a single file with syntax highlighting and edit capability.
 */

import { useState, useEffect } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Edit2, Save, X, Copy, Check, FileCode } from 'lucide-react'
import { cn, copyTextToClipboard } from '@/lib/utils'
import type { WorkspaceFile } from '@/types/workspace'

interface SingleFileViewerProps {
  /** File to display */
  file: WorkspaceFile;
  /** Whether we're in edit mode */
  isEditing: boolean;
  /** Content being edited (null if not editing) */
  editedContent: string | null;
  /** Start editing callback */
  onStartEdit: () => void;
  /** Save callback */
  onSave: () => void;
  /** Cancel editing callback */
  onCancel: () => void;
  /** Content change callback */
  onContentChange: (content: string) => void;
  /** Additional CSS classes */
  className?: string;
}

export const SingleFileViewer = ({
  file,
  isEditing,
  editedContent,
  onStartEdit,
  onSave,
  onCancel,
  onContentChange,
  className = "",
}: SingleFileViewerProps) => {
  const [didCopy, setDidCopy] = useState(false)
  
  // Reset copy state after delay
  useEffect(() => {
    if (!didCopy) return
    const timer = setTimeout(() => setDidCopy(false), 1500)
    return () => clearTimeout(timer)
  }, [didCopy])
  
  const handleCopy = async () => {
    const content = isEditing && editedContent !== null ? editedContent : file.content
    const ok = await copyTextToClipboard(content)
    if (ok) setDidCopy(true)
  }
  
  // Determine if content has been modified
  const hasChanges = isEditing && editedContent !== null && editedContent !== file.content
  
  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* File Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="w-4 h-4 text-gray-500 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-700 truncate">
            {file.path}
          </span>
          {file.isModified && !isEditing && (
            <span className="px-1.5 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">
              Modified
            </span>
          )}
          {file.isNew && (
            <span className="px-1.5 py-0.5 text-xs bg-green-100 text-green-700 rounded">
              New
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                onClick={onCancel}
                className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                title="Cancel editing"
              >
                <X className="w-4 h-4" />
                <span>Cancel</span>
              </button>
              <button
                onClick={onSave}
                disabled={!hasChanges}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-sm rounded transition-colors",
                  hasChanges
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "bg-gray-200 text-gray-500 cursor-not-allowed"
                )}
                title="Save changes"
              >
                <Save className="w-4 h-4" />
                <span>Save</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleCopy}
                className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                title="Copy file contents"
              >
                {didCopy ? (
                  <Check className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={onStartEdit}
                className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded transition-colors"
                title="Edit file"
              >
                <Edit2 className="w-4 h-4" />
                <span>Edit</span>
              </button>
            </>
          )}
        </div>
      </div>
      
      {/* File Content */}
      <div className="flex-1 overflow-auto">
        {isEditing && editedContent !== null ? (
          <textarea
            value={editedContent}
            onChange={(e) => onContentChange(e.target.value)}
            className="w-full h-full p-4 font-mono text-sm bg-white border-0 resize-none focus:outline-none focus:ring-0"
            spellCheck={false}
          />
        ) : (
          <SyntaxHighlighter
            language={file.language}
            style={oneLight}
            showLineNumbers={true}
            customStyle={{
              margin: 0,
              padding: '1rem',
              fontSize: '0.875rem',
              lineHeight: '1.5',
              background: '#fff',
            }}
            codeTagProps={{
              style: {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              },
            }}
          >
            {file.content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  )
}
