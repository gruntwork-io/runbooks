import React, { useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { FileTreeContext } from './FileTreeContext.types'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'

interface FileTreeProviderProps {
  children: ReactNode
}

export const FileTreeProvider: React.FC<FileTreeProviderProps> = ({ children }) => {
  const [fileTree, setFileTree] = useState<FileTreeNode[] | null>(null)
  
  // Stable reference to prevent unnecessary re-renders in consuming components
  // Support both direct values and functional updates
  const stableSetFileTree = useCallback((newFileTree: FileTreeNode[] | null | ((prevFileTree: FileTreeNode[] | null) => FileTreeNode[] | null)) => {
    setFileTree(newFileTree)
  }, [])

  return (
    <FileTreeContext.Provider value={{ fileTree, setFileTree: stableSetFileTree }}>
      {children}
    </FileTreeContext.Provider>
  )
}

