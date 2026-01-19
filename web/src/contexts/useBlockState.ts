/**
 * # Block State Context Hooks
 * 
 * This file provides React hooks for sharing state between MDX blocks
 * (Inputs, Template, TemplateInline, Command, Check).
 * 
 * ## Core Concepts
 * 
 * ### Input Variables
 * When a block (like `<Template>`) references another block via `inputsId`, it "imports"
 * that block's variable values. This enables a data flow where:
 * 
 * 1. **Inputs/Template** blocks collect values from the user and register them to the context
 * 2. **Downstream blocks** (Template, TemplateInline, Command, Check) import those values
 * 
 * ### Block Outputs
 * When a Check or Command block executes a script that writes to $RUNBOOK_OUTPUT,
 * those outputs are captured and stored in the context. Downstream blocks can reference
 * these outputs via the `_blocks` namespace in templates:
 * 
 * ```
 * {{ ._blocks.create-account.outputs.account_id }}
 * ```
 * 
 * ## Example Usage
 * 
 * ```tsx
 * // In a component that imports values from other blocks:
 * const importedVarValues = useImportedVarValues(inputsId);
 * 
 * // In a component that needs to register its values:
 * const { registerInputs } = useBlockState();
 * registerInputs(id, values, config);
 * 
 * // In a component that produces outputs:
 * const { registerOutputs } = useBlockState();
 * registerOutputs(blockId, { account_id: "123456789012" });
 * 
 * // Get template variables for rendering (inputs at root + _blocks namespace):
 * const templateVars = useTemplateVariables(inputsId);
 * ```
 * 
 * @see BlockStateContext - The context provider
 * @see Template - Main consumer that demonstrates all patterns
 */

import { useContext, useMemo, useRef } from 'react'
import { BlockStateContext, type BlockStateContextType } from './BlockStateContext'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

// Stable empty objects to avoid creating new references
const EMPTY_VALUES: Record<string, unknown> = {}
const EMPTY_CONFIG: BoilerplateConfig = { variables: [], rawYaml: '' }
const EMPTY_OUTPUTS: Record<string, string> = {}
const EMPTY_TEMPLATE_VARS: Record<string, unknown> = { _blocks: {} }

/**
 * Hook to access the block state context
 */
export function useBlockState(): BlockStateContextType {
  const context = useContext(BlockStateContext)
  if (!context) {
    throw new Error('useBlockState must be used within a BlockStateProvider')
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
  const context = useContext(BlockStateContext)
  
  // Get the inputs from context to track changes
  const inputs = context?.inputs
  
  // Track previous result to maintain referential stability
  const prevResultRef = useRef<Record<string, unknown>>(EMPTY_VALUES)
  
  return useMemo(() => {
    if (!context || !inputsId) return EMPTY_VALUES
    
    const newValues = context.getInputValues(inputsId)
    
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
  const context = useContext(BlockStateContext)
  
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
  const context = useContext(BlockStateContext)
  
  // Get the inputs from context to track changes
  const inputs = context?.inputs
  
  return useMemo(() => {
    if (!context || !inputsId) return 'variables: []'
    return context.generateYaml(inputsId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, inputs])
}

/**
 * Hook to get outputs from a specific block.
 * 
 * @param blockId - The ID of the block whose outputs to get
 * @returns The block's output values, or undefined if no outputs exist
 */
export function useBlockOutputs(blockId: string | undefined): Record<string, string> | undefined {
  const context = useContext(BlockStateContext)
  
  // Get the outputs from context to track changes
  const outputs = context?.outputs
  
  return useMemo(() => {
    if (!context || !blockId) return undefined
    return context.getOutputValues(blockId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, outputs])
}

/**
 * Hook to get all block outputs.
 * Returns the entire outputs map for use in dependency tracking.
 */
export function useAllBlockOutputs(): Record<string, { values: Record<string, string>; timestamp: string }> {
  const context = useContext(BlockStateContext)
  return context?.outputs ?? {}
}

/**
 * Hook to get template variables for rendering.
 * Returns input values spread at root level, plus _blocks namespace with all block outputs.
 * 
 * @example
 * // With inputsId "aws-config" containing { region: "us-west-2" }
 * // And block "create-account" with outputs { account_id: "123456789012" }
 * // Returns:
 * // {
 * //   region: "us-west-2",
 * //   _blocks: {
 * //     "create-account": { outputs: { account_id: "123456789012" } }
 * //   }
 * // }
 * const templateVars = useTemplateVariables("aws-config");
 */
export function useTemplateVariables(inputsId?: string | string[]): Record<string, unknown> {
  const context = useContext(BlockStateContext)
  
  // Track both inputs and outputs for re-renders
  const inputs = context?.inputs
  const outputs = context?.outputs
  
  return useMemo(() => {
    if (!context) return EMPTY_TEMPLATE_VARS
    return context.getTemplateVariables(inputsId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, inputs, outputs])
}
