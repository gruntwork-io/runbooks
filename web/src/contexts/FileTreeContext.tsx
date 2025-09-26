import React, { useState } from 'react'
import type { ReactNode } from 'react'
import { FileTreeContext } from './FileTreeContext.types'
import type { CodeFileData } from '../components/artifacts/code/FileTree'

interface FileTreeProviderProps {
  children: ReactNode
}

export const FileTreeProvider: React.FC<FileTreeProviderProps> = ({ children }) => {
  const [fileTree, setFileTree] = useState<CodeFileData[] | null>(null)

  return (
    <FileTreeContext.Provider value={{ fileTree, setFileTree }}>
      {children}
    </FileTreeContext.Provider>
  )
}

