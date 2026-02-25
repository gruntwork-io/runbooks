import { createContext } from 'react'
import type { FileTreeNode } from '../components/artifacts/code/FileTree'

export interface GeneratedFilesContextType {
  fileTree: FileTreeNode[] | null
  setFileTree: (fileTree: FileTreeNode[] | null | ((prevFileTree: FileTreeNode[] | null) => FileTreeNode[] | null)) => void
  localPath: string | null
  setLocalPath: (path: string | null) => void
  /** Whether file-generating templates are allowed to auto-render. False while the
   *  "Existing Generated Files Detected" alert is pending so that TemplateInline
   *  components don't regenerate files before the user decides to keep or delete. */
  renderingEnabled: boolean
  setRenderingEnabled: (enabled: boolean) => void
}

export const GeneratedFilesContext = createContext<GeneratedFilesContextType | undefined>(undefined)
