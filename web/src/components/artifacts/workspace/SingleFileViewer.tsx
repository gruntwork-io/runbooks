/**
 * @fileoverview SingleFileViewer Component
 * 
 * Displays a single file with syntax highlighting and edit capability.
 */

import { useState, useEffect, useRef, useTransition } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Edit2, Save, X, Copy, Check, FileCode, Image, FileQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { WorkspaceFile } from '@/types/workspace'

// Custom style that removes italic from line numbers
const customStyle = {
  ...oneLight,
  'linenumber': {
    ...((oneLight as Record<string, React.CSSProperties>)['linenumber'] || {}),
    fontStyle: 'normal',
  },
}

// Image file extensions
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']

// Binary/non-displayable file extensions
const BINARY_EXTENSIONS = ['exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'zip', 'tar', 'gz', 'rar', '7z', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp3', 'mp4', 'avi', 'mov', 'wav', 'flac', 'ttf', 'otf', 'woff', 'woff2', 'eot']

/**
 * Determine the file type based on extension
 */
function getFileType(filename: string): 'image' | 'binary' | 'text' {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
  if (BINARY_EXTENSIONS.includes(ext)) return 'binary'
  return 'text'
}

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
  const { didCopy, copy } = useCopyToClipboard()
  const [lineCount, setLineCount] = useState(0)
  const [isDirty, setIsDirty] = useState(false)
  const lineNumbersRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLPreElement>(null)
  const [, startTransition] = useTransition()
  
  // Reset dirty state only when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setIsDirty(false)
    }
  }, [isEditing])

  // Update line count when content changes in edit mode
  useEffect(() => {
    if (isEditing && editedContent !== null) {
      setLineCount(editedContent.split('\n').length)
    }
  }, [isEditing, editedContent])
  
  // Sync scroll between editor and line numbers
  const handleEditorScroll = () => {
    if (lineNumbersRef.current && editorRef.current) {
      lineNumbersRef.current.scrollTop = editorRef.current.scrollTop
    }
  }
  
  // Handle input in contenteditable - update line count and dirty state
  const handleEditorInput = () => {
    if (editorRef.current) {
      const content = editorRef.current.textContent || ''
      setLineCount(content.split('\n').length)
      setIsDirty(true)
    }
  }
  
  // Sync content to parent before save
  const handleSave = () => {
    if (editorRef.current) {
      onContentChange(editorRef.current.textContent || '')
    }
    // Small delay to ensure state is updated before save
    setTimeout(onSave, 0)
  }
  
  const handleCopy = () => {
    const content = isEditing && editedContent !== null ? editedContent : file.content
    copy(content)
  }
  
  const handleCancel = () => {
    // Use transition to keep UI responsive while heavy re-renders happen
    startTransition(() => {
      onCancel()
    })
  }
  
  // Determine if content has been modified
  const hasChanges = isEditing && isDirty
  
  // Determine file type
  const fileType = getFileType(file.name)
  const isEditable = fileType === 'text'
  
  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* File Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2 min-w-0">
          {fileType === 'image' ? (
            <Image className="w-4 h-4 text-gray-500 flex-shrink-0" />
          ) : fileType === 'binary' ? (
            <FileQuestion className="w-4 h-4 text-gray-500 flex-shrink-0" />
          ) : (
            <FileCode className="w-4 h-4 text-gray-500 flex-shrink-0" />
          )}
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
                onClick={handleCancel}
                className="flex items-center gap-1 px-2 py-1 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 active:bg-gray-200 rounded cursor-pointer"
                title="Cancel editing"
              >
                <X className="w-4 h-4" />
                <span>Cancel</span>
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-sm rounded",
                  hasChanges
                    ? "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 cursor-pointer"
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
                onClick={isEditable ? handleCopy : undefined}
                className={cn(
                  "p-1.5 rounded",
                  isEditable
                    ? "text-gray-500 hover:text-gray-700 hover:bg-gray-100 active:bg-gray-200 cursor-pointer"
                    : "text-transparent cursor-default"
                )}
                title={isEditable ? "Copy file contents" : undefined}
                disabled={!isEditable}
                aria-hidden={!isEditable}
              >
                {didCopy ? (
                  <Check className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={isEditable ? onStartEdit : undefined}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-sm rounded",
                  isEditable
                    ? "text-gray-600 hover:text-gray-800 hover:bg-gray-100 active:bg-gray-200 cursor-pointer"
                    : "text-transparent cursor-default"
                )}
                title={isEditable ? "Edit file" : undefined}
                disabled={!isEditable}
                aria-hidden={!isEditable}
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
        {fileType === 'image' ? (
          // Image viewer
          <div className="flex items-center justify-center h-full p-8 bg-white">
            <img 
              src={file.content.startsWith('data:') || file.content.startsWith('http') 
                ? file.content 
                : `data:image/${file.name.split('.').pop()};base64,${file.content}`}
              alt={file.name}
              className="max-w-full max-h-full object-contain rounded shadow-sm"
              onError={(e) => {
                // If base64 fails, try showing as placeholder
                e.currentTarget.style.display = 'none'
                e.currentTarget.nextElementSibling?.classList.remove('hidden')
              }}
            />
            <div className="hidden flex-col items-center gap-2 text-gray-500">
              <Image className="w-16 h-16" />
              <p className="text-sm">Unable to preview image</p>
            </div>
          </div>
        ) : fileType === 'binary' ? (
          // Binary/non-displayable file message
          <div className="flex flex-col items-center justify-center h-full p-8 bg-white text-gray-500">
            <FileQuestion className="w-16 h-16 mb-4" />
            <p className="text-lg font-medium mb-2">Cannot display this file</p>
            <p className="text-sm text-gray-400">
              Sorry, but we can't display this file type ({file.name.split('.').pop()?.toUpperCase() || 'unknown'}).
            </p>
          </div>
        ) : isEditing && editedContent !== null ? (
          // Text editor
          <div 
            className="flex h-full bg-white"
            style={{ padding: '1rem' }}
          >
            {/* Line Numbers */}
            <div 
              ref={lineNumbersRef}
              className="flex-shrink-0 text-right select-none bg-white overflow-hidden"
              style={{ 
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: '0.8rem',
                lineHeight: '1.5',
                color: 'rgb(160, 161, 167)',
                minWidth: '3.25em',
                paddingRight: '1em',
              }}
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            {/* Editor - using pre+code for consistent rendering with view mode */}
            <pre
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handleEditorInput}
              onScroll={handleEditorScroll}
              className="flex-1 bg-white border-0 m-0 focus:outline-none focus:ring-0 overflow-auto"
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: '0.8rem',
                lineHeight: '1.5',
                tabSize: 4,
                MozTabSize: 4,
                padding: 0,
                marginLeft: '-3px',
                whiteSpace: 'pre',
              } as React.CSSProperties}
              spellCheck={false}
            >
              {editedContent}
            </pre>
          </div>
        ) : (
          // Text viewer with syntax highlighting
          <div className="syntax-viewer">
            <style>{`.syntax-viewer .react-syntax-highlighter-line-number { font-style: normal !important; }`}</style>
            <SyntaxHighlighter
              language={file.language}
              style={customStyle}
              showLineNumbers={true}
              customStyle={{
                margin: 0,
                padding: '1rem',
                fontSize: '0.8rem',
                lineHeight: '1.5',
                background: '#fff',
                tabSize: 4,
              }}
              codeTagProps={{
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  tabSize: 4,
                  MozTabSize: 4,
                  whiteSpace: 'pre',
                } as React.CSSProperties,
              }}
            >
              {file.content}
            </SyntaxHighlighter>
          </div>
        )}
      </div>
    </div>
  )
}
