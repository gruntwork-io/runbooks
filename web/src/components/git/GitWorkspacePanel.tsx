import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useGitWorkspace } from '../../contexts/useGitWorkspace'
import { FileTree, type FileTreeNode } from '../artifacts/code/FileTree'
import { CodeFile } from '../artifacts/code/CodeFile'
import { ChevronLeft, GitBranch, FolderGit, RefreshCw, AlertCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { ChangesPanel } from './ChangesPanel'

interface GitWorkspacePanelProps {
  onHide?: () => void
}

export function GitWorkspacePanel({ onHide }: GitWorkspacePanelProps) {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
    refreshWorkspaceStatus,
    activeChangedFiles,
  } = useGitWorkspace()

  const [treeWidth, setTreeWidth] = useState(200)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [showChangesPanel, setShowChangesPanel] = useState(true)
  
  // Refs for scrolling to files
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const workspaceList = Object.values(workspaces)
  const activeWorkspace = activeWorkspaceId ? workspaces[activeWorkspaceId] : null

  // Build file tree from workspace
  const fileTree = useMemo(() => {
    if (!activeWorkspace?.fileTree) return []
    return activeWorkspace.fileTree
  }, [activeWorkspace?.fileTree])

  // Extract file items for the file viewer
  const fileItems = useMemo(() => {
    const files: FileTreeNode[] = []
    const traverse = (items: FileTreeNode[]) => {
      items.forEach(item => {
        if (item.type === 'file' && item.file) {
          files.push(item)
        }
        if (item.children) {
          traverse(item.children)
        }
      })
    }
    traverse(fileTree)
    return files
  }, [fileTree])

  const handleFileClick = (item: FileTreeNode) => {
    if (item.type === 'file' && item.file) {
      setSelectedFileId(item.id)
    }
  }
  
  // Scroll to selected file when it changes
  useEffect(() => {
    if (selectedFileId) {
      const element = fileRefs.current.get(selectedFileId)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
  }, [selectedFileId])
  
  // Register file ref
  const setFileRef = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) {
      fileRefs.current.set(id, element)
    } else {
      fileRefs.current.delete(id)
    }
  }, [])

  const handleRefresh = async () => {
    if (activeWorkspaceId) {
      await refreshWorkspaceStatus(activeWorkspaceId)
    }
  }

  // No workspaces registered yet
  if (workspaceList.length === 0) {
    return (
      <div className="w-full h-full flex flex-col">
        <div className="flex items-start justify-between py-2 mb-3 border-b border-gray-200 bg-transparent px-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-700">Git Workspace</h2>
            <p className="text-xs text-gray-500 mt-1">Clone a repository to see files here</p>
          </div>
          {onHide && (
            <button
              onClick={onHide}
              className="hidden lg:block p-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-all duration-200 cursor-pointer"
              title="Hide panel"
            >
              <ChevronLeft className="w-5 h-5 text-gray-600" />
            </button>
          )}
        </div>

        <div className="flex-1 flex items-center justify-center p-1">
          <div className="text-center">
            <FolderGit className="w-16 h-16 mx-auto mb-2 text-gray-300" />
            <h3 className="text-lg font-medium mb-2 text-gray-600">
              No Git workspace yet
            </h3>
            <p className="text-sm text-gray-500">
              Use a <code className="bg-gray-100 px-1 rounded">{"<GitClone>"}</code> block in your runbook to clone a repository.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between py-2 mb-3 border-b border-gray-200 bg-transparent px-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-700">Git Workspace</h2>
          
          {/* Workspace selector (if multiple) */}
          {workspaceList.length > 1 ? (
            <select
              value={activeWorkspaceId || ''}
              onChange={(e) => setActiveWorkspaceId(e.target.value || null)}
              className="mt-1 text-sm border rounded px-2 py-1"
            >
              {workspaceList.map(ws => (
                <option key={ws.id} value={ws.id}>
                  {ws.repo} ({ws.branch})
                </option>
              ))}
            </select>
          ) : activeWorkspace && (
            <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
              <GitBranch className="size-3" />
              <span className="font-mono">{activeWorkspace.repo}</span>
              <span className="text-gray-400">@</span>
              <span className="font-mono">{activeWorkspace.branch}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={!activeWorkspaceId || activeWorkspace?.isLoading}
            title="Refresh status"
          >
            <RefreshCw className={`size-4 ${activeWorkspace?.isLoading ? 'animate-spin' : ''}`} />
          </Button>
          
          {onHide && (
            <button
              onClick={onHide}
              className="hidden lg:block p-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-all duration-200 cursor-pointer"
              title="Hide panel"
            >
              <ChevronLeft className="w-5 h-5 text-gray-600" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {activeWorkspace && fileTree.length > 0 ? (
        <div className="flex-1 relative overflow-hidden">
          <div className="absolute inset-0 p-1">
            <FileTree
              items={fileTree}
              onItemClick={handleFileClick}
              onWidthChange={setTreeWidth}
              className="absolute"
              minWidth={150}
              maxWidth={300}
            />

            <div
              className="overflow-y-auto h-full"
              style={{ marginLeft: `${treeWidth}px` }}
            >
              {fileItems.map((fileItem) => (
                <div 
                  key={fileItem.id}
                  ref={(el) => setFileRef(fileItem.id, el)}
                  className={selectedFileId === fileItem.id ? 'ring-2 ring-blue-400 ring-offset-2 rounded-lg' : ''}
                >
                  <CodeFile
                    fileName={fileItem.file?.name || fileItem.name}
                    filePath={fileItem.file?.path || fileItem.name}
                    code={fileItem.file?.content || ''}
                    language={fileItem.file?.language || 'text'}
                    showLineNumbers={true}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Changes panel at bottom */}
          {activeChangedFiles.length > 0 && showChangesPanel && (
            <ChangesPanel
              files={activeChangedFiles}
              onClose={() => setShowChangesPanel(false)}
              onFileClick={(path) => {
                // Find and select the file
                const file = fileItems.find(f => f.file?.path === path)
                if (file) {
                  setSelectedFileId(file.id)
                }
              }}
            />
          )}
        </div>
      ) : activeWorkspace ? (
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            {activeWorkspace.isLoading ? (
              <>
                <RefreshCw className="w-12 h-12 mx-auto mb-2 text-blue-400 animate-spin" />
                <p className="text-sm text-gray-500">Loading workspace...</p>
              </>
            ) : (
              <>
                <AlertCircle className="w-12 h-12 mx-auto mb-2 text-amber-400" />
                <p className="text-sm text-gray-500">
                  Files not loaded yet. Run blocks to modify files.
                </p>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
