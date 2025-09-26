import { useContext } from 'react'
import { FileTreeContext, type FileTreeContextType } from '../contexts/FileTreeContext.types'

export const useFileTree = (): FileTreeContextType => {
  const context = useContext(FileTreeContext)
  if (context === undefined) {
    throw new Error('useFileTree must be used within a FileTreeProvider')
  }
  return context
}

// Re-export the context for backward compatibility
export { FileTreeContext }
