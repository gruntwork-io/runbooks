import React, { useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { GeneratedFilesContext } from './GeneratedFilesContext.types'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'
import type { TruncationInfo } from './GeneratedFilesContext.types'

interface GeneratedFilesProviderProps {
  children: ReactNode
}

export const GeneratedFilesProvider: React.FC<GeneratedFilesProviderProps> = ({ children }) => {
  const [fileTree, setFileTree] = useState<FileTreeNode[] | null>(null)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [truncationInfo, setTruncationInfoState] = useState<TruncationInfo | null>(null)

  // Stable reference to prevent unnecessary re-renders in consuming components
  // Support both direct values and functional updates
  const stableSetFileTree = useCallback((newFileTree: FileTreeNode[] | null | ((prevFileTree: FileTreeNode[] | null) => FileTreeNode[] | null)) => {
    setFileTree(newFileTree)
  }, [])

  const stableSetLocalPath = useCallback((path: string | null) => {
    setLocalPath(path)
  }, [])

  const stableSetTruncationInfo = useCallback((info: TruncationInfo | null) => {
    setTruncationInfoState(info)
  }, [])

  return (
    <GeneratedFilesContext.Provider value={{ fileTree, setFileTree: stableSetFileTree, localPath, setLocalPath: stableSetLocalPath, truncationInfo, setTruncationInfo: stableSetTruncationInfo }}>
      {children}
    </GeneratedFilesContext.Provider>
  )
}
