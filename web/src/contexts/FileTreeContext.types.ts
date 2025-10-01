import { createContext } from 'react'
import type { CodeFileData } from '../components/artifacts/code/FileTree'

export interface FileTreeContextType {
  fileTree: CodeFileData[] | null
  setFileTree: (fileTree: CodeFileData[] | null | ((prevFileTree: CodeFileData[] | null) => CodeFileData[] | null)) => void
}

export const FileTreeContext = createContext<FileTreeContextType | undefined>(undefined)
