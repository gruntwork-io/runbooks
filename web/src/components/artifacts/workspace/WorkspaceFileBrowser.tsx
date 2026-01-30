/**
 * @fileoverview WorkspaceFileBrowser Component
 * 
 * File browser for the "All" tab showing a file tree on the left
 * and a single file viewer on the right. Supports editing files.
 */

import { useState, useMemo } from 'react'
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
  const [treeWidth, setTreeWidth] = useState(200)
  const [editedContent, setEditedContent] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  
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
    <div className={cn("h-full flex overflow-hidden", className)}>
      {/* File Tree */}
      <div 
        className="flex-shrink-0 border-r border-gray-200 overflow-auto bg-gray-50"
        style={{ width: `${treeWidth}px` }}
      >
        <FileTree
          items={fileTreeData}
          onItemClick={handleFileSelect}
          onWidthChange={setTreeWidth}
          className="relative"
          minWidth={150}
          maxWidth={300}
        />
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
