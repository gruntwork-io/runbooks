/**
 * @fileoverview WorkspaceFileBrowser Component
 * 
 * File browser for the "All" tab showing a file tree on the left
 * and a single file viewer on the right. Supports editing files.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { FileTree } from '../code/FileTree'
import { SingleFileViewer } from './SingleFileViewer'
import { FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceTreeNode, WorkspaceFile } from '@/types/workspace'
import type { FileTreeNode } from '../code/FileTree'

interface WorkspaceFileBrowserProps {
  /** Files in the workspace */
  files: WorkspaceTreeNode[];
  /** Additional CSS classes */
  className?: string;
}

export const WorkspaceFileBrowser = ({
  files,
  className = "",
}: WorkspaceFileBrowserProps) => {
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null)
  const [treeWidth, setTreeWidth] = useState(225)
  const [editedContent, setEditedContent] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(225) // Track width without causing re-renders
  const rafRef = useRef<number | null>(null)
  
  // Handle resize drag - update DOM directly for performance
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    widthRef.current = treeWidth
    setIsResizing(true)
  }, [treeWidth])
  
  useEffect(() => {
    if (!isResizing) return
    
    const handleMouseMove = (e: MouseEvent) => {
      // Cancel any pending animation frame
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
      
      // Schedule update on next animation frame
      rafRef.current = requestAnimationFrame(() => {
        if (!containerRef.current || !treeRef.current) return
        const containerRect = containerRef.current.getBoundingClientRect()
        const newWidth = Math.min(Math.max(e.clientX - containerRect.left, 150), 400)
        // Update DOM directly - no React re-render
        treeRef.current.style.width = `${newWidth}px`
        widthRef.current = newWidth
      })
    }
    
    const handleMouseUp = () => {
      // Cancel any pending animation frame
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      // Only update React state when done dragging
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
  const fileTreeData = useMemo(() => convertToFileTreeNodes(files), [files])
  
  // Handle file selection from tree
  const handleFileSelect = (item: FileTreeNode) => {
    if (item.type === 'file' && item.file) {
      // Find the corresponding workspace file
      const workspaceFile = findWorkspaceFile(files, item.id)
      if (workspaceFile) {
        // If we're editing and switching files, ask to save/discard
        if (isEditing && editedContent !== null) {
          // For now, just discard - in future, show a confirmation dialog
          setEditedContent(null)
          setIsEditing(false)
        }
        setSelectedFile(workspaceFile)
      }
    }
  }
  
  // Handle edit mode
  const handleStartEdit = () => {
    if (selectedFile) {
      setEditedContent(selectedFile.content)
      setIsEditing(true)
    }
  }
  
  // Handle save
  const handleSave = () => {
    if (selectedFile && editedContent !== null) {
      // In the future, this will call an API to persist the changes
      console.log('Saving file:', selectedFile.path, editedContent)
      
      // Update the selected file with new content (in future, this comes from API response)
      setSelectedFile({
        ...selectedFile,
        content: editedContent,
        isModified: editedContent !== selectedFile.originalContent,
      })
      setEditedContent(null)
      setIsEditing(false)
    }
  }
  
  // Handle cancel edit
  const handleCancelEdit = () => {
    setEditedContent(null)
    setIsEditing(false)
  }
  
  // Handle content change
  const handleContentChange = (newContent: string) => {
    setEditedContent(newContent)
  }
  
  // Empty state
  if (files.length === 0) {
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
          onItemClick={handleFileSelect}
          className="relative"
        />
      </div>
      
      {/* Resize Handle - 7px hit area with 1px visible line */}
      <div
        className="w-[7px] cursor-col-resize flex-shrink-0 flex items-stretch justify-center group"
        onMouseDown={handleMouseDown}
      >
        <div className="w-px bg-gray-400 group-hover:bg-blue-500 group-hover:shadow-[0_0_0_2px_rgba(59,130,246,0.5)] transition-all" />
      </div>
      
      {/* File Viewer */}
      <div className="flex-1 h-full overflow-y-auto">
        {selectedFile ? (
          <SingleFileViewer
            file={selectedFile}
            isEditing={isEditing}
            editedContent={editedContent}
            onStartEdit={handleStartEdit}
            onSave={handleSave}
            onCancel={handleCancelEdit}
            onContentChange={handleContentChange}
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
 * Convert WorkspaceTreeNode to FileTreeNode
 */
function convertToFileTreeNodes(nodes: WorkspaceTreeNode[]): FileTreeNode[] {
  return nodes.map(node => ({
    id: node.id,
    name: node.name,
    type: node.type,
    children: node.children ? convertToFileTreeNodes(node.children) : undefined,
    file: node.file ? {
      name: node.file.name,
      path: node.file.path,
      content: node.file.content,
      language: node.file.language,
      size: node.file.content.length,
    } : undefined,
  }))
}

/**
 * Find a workspace file by ID
 */
function findWorkspaceFile(nodes: WorkspaceTreeNode[], id: string): WorkspaceFile | null {
  for (const node of nodes) {
    if (node.id === id && node.file) {
      return node.file
    }
    if (node.children) {
      const found = findWorkspaceFile(node.children, id)
      if (found) return found
    }
  }
  return null
}
