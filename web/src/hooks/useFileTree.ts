// Re-export from useGeneratedFiles for backward compatibility
import { useGeneratedFiles, GeneratedFilesContext } from './useGeneratedFiles'
import type { GeneratedFilesContextType } from '../contexts/GeneratedFilesContext.types'

// Wrap useGeneratedFiles to return the old interface shape (without localPath)
export const useFileTree = (): {
  fileTree: GeneratedFilesContextType['fileTree'],
  setFileTree: GeneratedFilesContextType['setFileTree'],
  truncationInfo: GeneratedFilesContextType['truncationInfo'],
  setTruncationInfo: GeneratedFilesContextType['setTruncationInfo'],
} => {
  const { fileTree, setFileTree, truncationInfo, setTruncationInfo } = useGeneratedFiles()
  return { fileTree, setFileTree, truncationInfo, setTruncationInfo }
}

// Re-export the context for backward compatibility
export { GeneratedFilesContext as FileTreeContext }
