import { createContext } from 'react'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'

export interface GeneratedFilesContextType {
  fileTree: FileTreeNode[] | null
  setFileTree: (fileTree: FileTreeNode[] | null | ((prevFileTree: FileTreeNode[] | null) => FileTreeNode[] | null)) => void
  localPath: string | null
  setLocalPath: (path: string | null) => void
}

export const GeneratedFilesContext = createContext<GeneratedFilesContextType | undefined>(undefined)
