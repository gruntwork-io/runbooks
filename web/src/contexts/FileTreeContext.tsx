import React, { useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { FileTreeContext } from './FileTreeContext.types'
import type { CodeFileData } from '../components/artifacts/code/FileTree'

interface FileTreeProviderProps {
  children: ReactNode
}

export const FileTreeProvider: React.FC<FileTreeProviderProps> = ({ children }) => {
  const [fileTree, setFileTree] = useState<CodeFileData[] | null>(null)
  
  // Stable reference to prevent unnecessary re-renders in consuming components
  // Support both direct values and functional updates
  const stableSetFileTree = useCallback((newFileTree: CodeFileData[] | null | ((prevFileTree: CodeFileData[] | null) => CodeFileData[] | null)) => {
    setFileTree(newFileTree)
  }, [])

  return (
    <FileTreeContext.Provider value={{ fileTree, setFileTree: stableSetFileTree }}>
      {children}
    </FileTreeContext.Provider>
  )
}

