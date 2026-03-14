import React, { useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { GeneratedFilesContext } from './GeneratedFilesContext.types'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'
import type { FileTreeResponse, TruncationInfo } from './GeneratedFilesContext.types'

interface GeneratedFilesProviderProps {
  children: ReactNode
}

export const GeneratedFilesProvider: React.FC<GeneratedFilesProviderProps> = ({ children }) => {
  const [fileTree, setFileTree] = useState<FileTreeNode[] | null>(null)
  const [localPath, setLocalPath] = useState<string | null>(null)
  const [truncationInfo, setTruncationInfo] = useState<TruncationInfo | null>(null)

  const stableSetLocalPath = useCallback((path: string | null) => {
    setLocalPath(path)
  }, [])

  const updateFileTree = useCallback((response: FileTreeResponse | null) => {
    if (!response) {
      setFileTree(null)
      setTruncationInfo(null)
      return
    }
    setFileTree(response.fileTree)
    setTruncationInfo(
      response.truncatedTree
        ? {
            truncatedTree: true,
            totalFiles: response.totalFiles ?? 0,
            heavyDir: response.heavyDir,
            heavyDirFileCount: response.heavyDirFileCount,
          }
        : null
    )
  }, [])

  return (
    <GeneratedFilesContext.Provider value={{ fileTree, truncationInfo, localPath, setLocalPath: stableSetLocalPath, updateFileTree }}>
      {children}
    </GeneratedFilesContext.Provider>
  )
}
