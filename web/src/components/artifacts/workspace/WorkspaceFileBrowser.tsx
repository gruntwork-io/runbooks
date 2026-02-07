/**
 * @fileoverview WorkspaceFileBrowser Component
 * 
 * File browser for the "All files" tab showing a structure-only file tree
 * on the left and a single file viewer on the right with lazy content loading.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { coy } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { FileTree } from '../code/FileTree'
import { FolderOpen, Loader2, AlertTriangle, RefreshCw, ImageIcon, FileX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFileContent } from '@/hooks/useFileContent'
import { useWorkspaceChanges } from '@/hooks/useWorkspaceChanges'
import { useGitWorkTree } from '@/contexts/GitWorkTreeContext'
import type { WorkspaceTreeNode } from '@/hooks/useWorkspaceTree'
import type { FileTreeNode } from '../code/FileTree'

interface WorkspaceFileBrowserProps {
  /** Structure-only tree (no content) from useWorkspaceTree */
  tree: WorkspaceTreeNode[] | null;
  /** Whether the tree is loading */
  isLoading: boolean;
  /** Error message if tree failed to load */
  error: string | null;
  /** Total file count */
  totalFiles: number;
  /** Callback to retry loading */
  onRetry: () => void;
  /** Additional CSS classes */
  className?: string;
}

export const WorkspaceFileBrowser = ({
  tree,
  isLoading,
  error,
  totalFiles: _totalFiles,
  onRetry,
  className = "",
}: WorkspaceFileBrowserProps) => {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [treeWidth, setTreeWidth] = useState(225)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(225)
  const rafRef = useRef<number | null>(null)
  
  // Lazy file content loader
  const { fetchFileContent, refetchFileContent, clearCache, fileContent, isLoading: contentLoading, error: contentError } = useFileContent()
  const { changes } = useWorkspaceChanges()
  const { activeWorkTree, treeVersion } = useGitWorkTree()

  // When changes are detected, refetch the currently selected file so All Files shows updated content
  const prevChangesRef = useRef<typeof changes>([])
  useEffect(() => {
    if (!selectedFilePath || !activeWorkTree?.localPath || changes.length === 0) return
    const selectedIsChanged = changes.some((c) => c.path === selectedFilePath)
    if (!selectedIsChanged) return
    // Avoid refetching on every poll if change list is unchanged
    const prevPaths = prevChangesRef.current.map((c) => c.path).sort().join(',')
    const currPaths = changes.map((c) => c.path).sort().join(',')
    if (prevPaths === currPaths) return
    prevChangesRef.current = changes
    const absPath = `${activeWorkTree.localPath}/${selectedFilePath}`
    refetchFileContent(absPath)
  }, [changes, selectedFilePath, activeWorkTree?.localPath, refetchFileContent])

  // When the worktree tree is invalidated (e.g. template wrote a file),
  // clear the cache so *any* file clicked afterward gets a fresh fetch,
  // and refetch the currently selected file immediately.
  const prevTreeVersionRef = useRef(treeVersion)
  useEffect(() => {
    if (treeVersion === prevTreeVersionRef.current) return
    prevTreeVersionRef.current = treeVersion
    clearCache()
    if (!selectedFilePath || !activeWorkTree?.localPath) return
    const absPath = `${activeWorkTree.localPath}/${selectedFilePath}`
    refetchFileContent(absPath)
  }, [treeVersion, selectedFilePath, activeWorkTree?.localPath, refetchFileContent, clearCache])
  
  // Handle resize drag - update DOM directly for performance
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    widthRef.current = treeWidth
    setIsResizing(true)
  }, [treeWidth])
  
  useEffect(() => {
    if (!isResizing) return
    
    const handleMouseMove = (e: MouseEvent) => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      
      rafRef.current = requestAnimationFrame(() => {
        if (!containerRef.current || !treeRef.current) return
        const containerRect = containerRef.current.getBoundingClientRect()
        const newWidth = Math.min(Math.max(e.clientX - containerRect.left, 150), 400)
        treeRef.current.style.width = `${newWidth}px`
        widthRef.current = newWidth
      })
    }
    
    const handleMouseUp = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      setTreeWidth(widthRef.current)
      setIsResizing(false)
    }
    
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isResizing])
  
  // Convert WorkspaceTreeNode to FileTreeNode for the existing FileTree component
  const fileTreeData = useMemo(() => {
    if (!tree) return []
    return convertToFileTreeNodes(tree)
  }, [tree])
  
  // Loading state
  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <Loader2 className="w-8 h-8 mx-auto mb-2 text-blue-500 animate-spin" />
          <p className="text-sm text-gray-500">Loading file tree...</p>
        </div>
      </div>
    )
  }
  
  // Error state
  if (error) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <AlertTriangle className="w-12 h-12 mx-auto mb-2 text-amber-400" />
          <h3 className="text-lg font-medium mb-1 text-gray-600">Failed to load file tree</h3>
          <p className="text-sm text-gray-500 mb-3">{error}</p>
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      </div>
    )
  }
  
  // Empty state
  if (!tree || tree.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full", className)}>
        <div className="text-center">
          <FolderOpen className="w-16 h-16 mx-auto mb-2 text-gray-300" />
          <h3 className="text-lg font-medium mb-2 text-gray-600">
            No workspace files
          </h3>
          <p className="text-sm text-gray-500">
            Clone a repository to see files here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div 
      ref={containerRef}
      className={cn("h-full flex overflow-hidden", isResizing && "select-none", className)}
    >
      {/* File Tree */}
      <div 
        ref={treeRef}
        className="flex-shrink-0 overflow-auto"
        style={{ width: `${treeWidth}px` }}
      >
        <FileTree
          items={fileTreeData}
          onItemClick={(item) => {
            if (item.type === 'file') {
              setSelectedFilePath(item.id)
              // Construct absolute path from worktree root + relative path
              if (activeWorkTree?.localPath) {
                const absPath = `${activeWorkTree.localPath}/${item.id}`
                fetchFileContent(absPath)
              }
            }
          }}
          className="relative"
        />
      </div>
      
      {/* Resize Handle */}
      <div
        className="w-[7px] cursor-col-resize flex-shrink-0 flex items-stretch justify-center group"
        onMouseDown={handleMouseDown}
      >
        <div className="w-px bg-gray-300 group-hover:bg-blue-500 group-hover:shadow-[0_0_0_2px_rgba(59,130,246,0.5)] transition-all" />
      </div>
      
      {/* File Viewer */}
      <div className="flex-1 h-full overflow-y-auto">
        {selectedFilePath ? (
          <FileContentViewer
            fileContent={fileContent}
            isLoading={contentLoading}
            error={contentError}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-500">
              <p className="text-sm">Select a file to view its contents</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * File content viewer that handles text, images, binary, and too-large files.
 */
function FileContentViewer({ fileContent, isLoading, error }: {
  fileContent: { path: string; content?: string; language: string; size: number; isImage?: boolean; mimeType?: string; dataUri?: string; isBinary?: boolean; isTooLarge?: boolean } | null
  isLoading: boolean
  error: string | null
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="w-6 h-6 mx-auto mb-2 text-blue-500 animate-spin" />
          <p className="text-sm text-gray-500">Loading file...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-amber-400" />
          <p className="text-sm text-gray-500">{error}</p>
        </div>
      </div>
    )
  }

  if (!fileContent) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-gray-500">Select a file to view its contents</p>
      </div>
    )
  }

  // Image file
  if (fileContent.isImage && fileContent.dataUri) {
    return (
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3 text-sm text-gray-600">
          <ImageIcon className="w-4 h-4" />
          <span className="font-mono text-xs">{fileContent.path.split('/').pop()}</span>
          <span className="text-gray-400">({formatFileSize(fileContent.size)})</span>
        </div>
        <img 
          src={fileContent.dataUri} 
          alt={fileContent.path.split('/').pop() || 'Image'} 
          className="max-w-full border border-gray-200 rounded" 
        />
      </div>
    )
  }

  // Binary file
  if (fileContent.isBinary) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <FileX className="w-12 h-12 mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-600 font-medium">Binary file</p>
          <p className="text-xs text-gray-400 mt-1">Cannot display content ({formatFileSize(fileContent.size)})</p>
        </div>
      </div>
    )
  }

  // Too large
  if (fileContent.isTooLarge) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <FileX className="w-12 h-12 mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-600 font-medium">File too large to display</p>
          <p className="text-xs text-gray-400 mt-1">{formatFileSize(fileContent.size)} (max 1 MB)</p>
        </div>
      </div>
    )
  }

  // Text content
  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-600 font-mono flex items-center justify-between">
        <span>{fileContent.path.split('/').pop()}</span>
        <span className="text-gray-400">{fileContent.language} • {formatFileSize(fileContent.size)}</span>
      </div>
      <div className="flex-1 overflow-auto">
        <SyntaxHighlighter
          language={fileContent.language}
          style={coy}
          showLineNumbers={true}
          customStyle={{
            fontSize: '12px',
            margin: 0,
            borderRadius: 0,
            border: 'none',
            padding: '14px 0px',
            background: 'transparent',
          }}
          lineNumberStyle={{
            color: '#999',
            fontSize: '11px',
            paddingRight: '12px',
            borderRight: '1px solid #eee',
            marginRight: '8px',
          }}
        >
          {fileContent.content || ''}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}

/**
 * Format file size in human-readable form
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Convert WorkspaceTreeNode (structure only) to FileTreeNode for the existing FileTree component
 */
function convertToFileTreeNodes(nodes: WorkspaceTreeNode[]): FileTreeNode[] {
  return nodes.map(node => ({
    id: node.id,
    name: node.name,
    type: node.type,
    children: node.children ? convertToFileTreeNodes(node.children) : undefined,
    // Store the path as a file property so we can fetch content on click
    file: node.type === 'file' ? {
      name: node.name,
      path: node.id, // Relative path used as ID
      content: '', // Content loaded lazily
      language: node.language || 'text',
      size: node.size || 0,
    } : undefined,
  }))
}
