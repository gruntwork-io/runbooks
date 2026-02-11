import { useContext } from 'react'
import { GeneratedFilesContext, type GeneratedFilesContextType } from '../contexts/GeneratedFilesContext.types'

export const useGeneratedFiles = (): GeneratedFilesContextType => {
  const context = useContext(GeneratedFilesContext)
  if (context === undefined) {
    throw new Error('useGeneratedFiles must be used within a GeneratedFilesProvider')
  }
  return context
}

// Re-export the context for backward compatibility
export { GeneratedFilesContext }
