import { useContext } from 'react'
import { BoilerplateVariablesContext } from './BoilerplateVariablesContext.types'

/**
 * Hook to access the boilerplate variables context.
 * 
 * Use this hook in components that need to publish or consume variable bindings.
 * Must be used within a BoilerplateVariablesProvider.
 * 
 * @returns The context containing variablesByInputsId, setVariables, and getVariables
 * @throws Error if used outside of BoilerplateVariablesProvider
 */
export function useBoilerplateVariables() {
  const context = useContext(BoilerplateVariablesContext)
  if (context === undefined) {
    throw new Error('useBoilerplateVariables must be used within a BoilerplateVariablesProvider')
  }
  return context
}

