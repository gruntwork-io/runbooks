import { useContext } from 'react'
import { ExecutableRegistryContext } from '@/contexts/ExecutableRegistryContext.types'

/**
 * Hook to access the executable registry from context.
 */
export function useIpcExecutableRegistry() {
  const context = useContext(ExecutableRegistryContext)
  if (context === undefined) {
    throw new Error('useIpcExecutableRegistry must be used within an ExecutableRegistryProvider')
  }
  return context
}
