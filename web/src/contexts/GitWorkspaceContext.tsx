import React, { useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { GitWorkspaceContext, GitWorkspace, GitFileStatus } from './GitWorkspaceContext.types'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'
import { useSession } from './useSession'

interface GitWorkspaceProviderProps {
  children: ReactNode
}

export const GitWorkspaceProvider: React.FC<GitWorkspaceProviderProps> = ({ children }) => {
  const [workspaces, setWorkspaces] = useState<Record<string, GitWorkspace>>({})
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const { getAuthHeader } = useSession()

  // Fetch file tree for a workspace
  const fetchWorkspaceFileTree = useCallback(async (id: string, workspacePath: string) => {
    try {
      const response = await fetch(`/api/git/files?path=${encodeURIComponent(workspacePath)}`, {
        headers: getAuthHeader(),
      })

      if (response.ok) {
        const data = await response.json()
        setWorkspaces(prev => {
          if (!prev[id]) return prev
          return {
            ...prev,
            [id]: {
              ...prev[id],
              fileTree: data.files || [],
              isLoading: false,
              lastUpdated: new Date(),
            }
          }
        })
      }
    } catch (error) {
      console.error('Failed to fetch workspace file tree:', error)
    }
  }, [getAuthHeader])

  // Register a new workspace
  const registerWorkspace = useCallback((workspace: Omit<GitWorkspace, 'fileTree' | 'changedFiles' | 'isLoading' | 'lastUpdated'>) => {
    setWorkspaces(prev => ({
      ...prev,
      [workspace.id]: {
        ...workspace,
        fileTree: null,
        changedFiles: [],
        isLoading: true,
        lastUpdated: null,
      }
    }))
    // Auto-activate the first workspace
    setActiveWorkspaceId(prevActive => prevActive || workspace.id)
    
    // Fetch file tree automatically
    fetchWorkspaceFileTree(workspace.id, workspace.workspacePath)
  }, [fetchWorkspaceFileTree])

  // Update a workspace
  const updateWorkspace = useCallback((id: string, updates: Partial<GitWorkspace>) => {
    setWorkspaces(prev => {
      if (!prev[id]) return prev
      return {
        ...prev,
        [id]: {
          ...prev[id],
          ...updates,
        }
      }
    })
  }, [])

  // Remove a workspace
  const removeWorkspace = useCallback((id: string) => {
    setWorkspaces(prev => {
      const { [id]: removed, ...rest } = prev
      return rest
    })
    // Clear active if it was the removed workspace
    setActiveWorkspaceId(prev => prev === id ? null : prev)
  }, [])

  // Refresh workspace status (file tree and changed files)
  const refreshWorkspaceStatus = useCallback(async (id: string) => {
    const workspace = workspaces[id]
    if (!workspace) return

    updateWorkspace(id, { isLoading: true })

    try {
      // Fetch git status and file tree in parallel
      const [statusResponse, filesResponse] = await Promise.all([
        fetch(`/api/git/status?path=${encodeURIComponent(workspace.workspacePath)}`, {
          headers: getAuthHeader(),
        }),
        fetch(`/api/git/files?path=${encodeURIComponent(workspace.workspacePath)}`, {
          headers: getAuthHeader(),
        }),
      ])

      const updates: Partial<GitWorkspace> = {
        isLoading: false,
        lastUpdated: new Date(),
      }

      if (statusResponse.ok) {
        const statusData = await statusResponse.json()
        updates.changedFiles = statusData.files || []
      }

      if (filesResponse.ok) {
        const filesData = await filesResponse.json()
        updates.fileTree = filesData.files || []
      }

      updateWorkspace(id, updates)
    } catch (error) {
      console.error('Failed to refresh workspace status:', error)
      updateWorkspace(id, { isLoading: false })
    }
  }, [workspaces, updateWorkspace, getAuthHeader])

  // Get active workspace's file tree
  const activeFileTree = useMemo(() => {
    if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) return null
    return workspaces[activeWorkspaceId].fileTree
  }, [activeWorkspaceId, workspaces])

  // Get active workspace's changed files
  const activeChangedFiles = useMemo(() => {
    if (!activeWorkspaceId || !workspaces[activeWorkspaceId]) return []
    return workspaces[activeWorkspaceId].changedFiles
  }, [activeWorkspaceId, workspaces])

  const value = useMemo(() => ({
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
    registerWorkspace,
    updateWorkspace,
    removeWorkspace,
    activeFileTree,
    activeChangedFiles,
    refreshWorkspaceStatus,
  }), [
    workspaces,
    activeWorkspaceId,
    registerWorkspace,
    updateWorkspace,
    removeWorkspace,
    activeFileTree,
    activeChangedFiles,
    refreshWorkspaceStatus,
  ])

  return (
    <GitWorkspaceContext.Provider value={value}>
      {children}
    </GitWorkspaceContext.Provider>
  )
}
