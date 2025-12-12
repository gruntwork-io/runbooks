/**
 * # Block Variables Context Hooks
 * 
 * This file provides React hooks for sharing variable values between MDX blocks
 * (Inputs, Template, TemplateInline, Command, Check).
 * 
 * ## Core Concept
 * 
 * When a block (like `<Template>`) references another block via `inputsId`, it "imports"
 * that block's variable values. This enables a data flow where:
 * 
 * 1. **Inputs/Template** blocks collect values from the user and register them to the context
 * 2. **Downstream blocks** (Template, TemplateInline, Command, Check) import those values
 * 
 * ## Example Usage
 * 
 * ```tsx
 * // In a component that imports values from other blocks:
 * const importedVarValues = useImportedVarValues(inputsId);
 * 
 * // In a component that needs to register its values:
 * const { registerInputs } = useBlockVariables();
 * registerInputs(id, values, config);
 * ```
 * 
 * @see BlockVariablesContext - The context provider
 * @see Template - Main consumer that demonstrates all patterns
 */

import { useContext, useMemo, useRef } from 'react'
import { BlockVariablesContext, type BlockVariablesContextType } from './BlockVariablesContext'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

// Stable empty objects to avoid creating new references
const EMPTY_VALUES: Record<string, unknown> = {}
const EMPTY_CONFIG: BoilerplateConfig = { variables: [], rawYaml: '' }

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
 * Hook to get imported variable values from one or more inputsIds.
 * 
 * "Imported" means values pulled from external Inputs/Template components
 * referenced via the `inputsId` prop.
 * 
 * Re-renders when values change.
 * 
 * @param inputsId - One or more IDs to import values from
 * @returns Merged variable values (later IDs override earlier ones)
 */
export function useImportedVarValues(inputsId: string | string[] | undefined): Record<string, unknown> {
  const context = useContext(BlockVariablesContext)
  
  // Get the inputs from context to track changes
  const inputs = context?.inputs
  
  // Track previous result to maintain referential stability
  const prevResultRef = useRef<Record<string, unknown>>(EMPTY_VALUES)
  
  return useMemo(() => {
    if (!context || !inputsId) return EMPTY_VALUES
    
    const newValues = context.getValues(inputsId)
    
    // Check if values actually changed (shallow comparison)
    const prevKeys = Object.keys(prevResultRef.current)
    const newKeys = Object.keys(newValues)
    const unchanged = prevKeys.length === newKeys.length &&
      prevKeys.every(key => prevResultRef.current[key] === newValues[key])
    
    if (unchanged) {
      return prevResultRef.current
    }
    
    prevResultRef.current = newValues
    return newValues
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, inputs])
}

/**
 * Hook to get merged config for one or more inputsIds.
 * Re-renders when configs change.
 */
export function useImportedConfig(inputsId: string | string[] | undefined): BoilerplateConfig {
  const context = useContext(BlockVariablesContext)
  
  // Get the inputs from context to track changes
  const inputs = context?.inputs
  
  return useMemo(() => {
    if (!context || !inputsId) return EMPTY_CONFIG
    return context.getConfig(inputsId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, inputs])
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, inputs])
}
