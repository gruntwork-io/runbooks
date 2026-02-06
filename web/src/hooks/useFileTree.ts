// Re-export from useGeneratedFiles for backward compatibility
import { useGeneratedFiles, GeneratedFilesContext } from './useGeneratedFiles'
import type { GeneratedFilesContextType } from '../contexts/GeneratedFilesContext.types'

// Wrap useGeneratedFiles to return the old interface shape (without localPath)
export const useFileTree = (): { fileTree: GeneratedFilesContextType['fileTree'], setFileTree: GeneratedFilesContextType['setFileTree'] } => {
  const { fileTree, setFileTree } = useGeneratedFiles()
  return { fileTree, setFileTree }
}

// Re-export the context for backward compatibility
export { GeneratedFilesContext as FileTreeContext }
