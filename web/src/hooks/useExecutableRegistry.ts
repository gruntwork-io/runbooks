import { useContext } from 'react'
import { ExecutableRegistryContext } from '@/contexts/ExecutableRegistryContext.types'

export function useExecutableRegistry() {
  const context = useContext(ExecutableRegistryContext)
  if (context === undefined) {
    throw new Error('useExecutableRegistry must be used within an ExecutableRegistryProvider')
  }
  return context
}

