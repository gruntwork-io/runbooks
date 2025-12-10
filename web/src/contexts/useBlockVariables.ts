import { useContext, useMemo } from 'react'
import { BlockVariablesContext, type BlockVariablesContextType } from './BlockVariablesContext'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

/**
 * Hook to access the block variables context
 */
export function useBlockVariables(): BlockVariablesContextType {
  const context = useContext(BlockVariablesContext)
  if (!context) {
    throw new Error('useBlockVariables must be used within a BlockVariablesProvider')
  }
  return context
}

/**
 * Hook to get merged values for one or more inputsIds.
 * Re-renders when values change.
 */
export function useInputValues(inputsId: string | string[] | undefined): Record<string, unknown> {
  const context = useContext(BlockVariablesContext)
  
  // Get the inputs from context to track changes
  const inputs = context?.inputs
  
  return useMemo(() => {
    if (!context || !inputsId) return {}
    return context.getValues(inputsId)
  }, [context, inputsId, inputs])
}

/**
 * Hook to get merged config for one or more inputsIds.
 * Re-renders when configs change.
 */
export function useInputConfig(inputsId: string | string[] | undefined): BoilerplateConfig {
  const context = useContext(BlockVariablesContext)
  
  // Get the inputs from context to track changes
  const inputs = context?.inputs
  
  return useMemo(() => {
    if (!context || !inputsId) return { variables: [], rawYaml: '' }
    return context.getConfig(inputsId)
  }, [context, inputsId, inputs])
}

/**
 * Hook to generate YAML for one or more inputsIds.
 * Re-renders when configs change.
 */
export function useGeneratedYaml(inputsId: string | string[] | undefined): string {
  const context = useContext(BlockVariablesContext)
  
  // Get the inputs from context to track changes
  const inputs = context?.inputs
  
  return useMemo(() => {
    if (!context || !inputsId) return 'variables: []'
    return context.generateYaml(inputsId)
  }, [context, inputsId, inputs])
}

