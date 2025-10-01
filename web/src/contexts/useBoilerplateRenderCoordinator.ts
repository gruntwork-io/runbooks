import { useContext } from 'react'
import { BoilerplateRenderCoordinatorContext } from './BoilerplateRenderCoordinator.types'

/**
 * Hook to access the BoilerplateRenderCoordinator context.
 * Must be used within a BoilerplateRenderCoordinatorProvider.
 */
export function useBoilerplateRenderCoordinator() {
  const context = useContext(BoilerplateRenderCoordinatorContext)
  
  if (!context) {
    throw new Error('useBoilerplateRenderCoordinator must be used within a BoilerplateRenderCoordinatorProvider')
  }
  
  return context
}

