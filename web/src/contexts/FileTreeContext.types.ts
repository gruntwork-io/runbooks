import { createContext } from 'react'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'

export interface FileTreeContextType {
  fileTree: FileTreeNode[] | null
  setFileTree: (fileTree: FileTreeNode[] | null | ((prevFileTree: FileTreeNode[] | null) => FileTreeNode[] | null)) => void
}

export const FileTreeContext = createContext<FileTreeContextType | undefined>(undefined)
