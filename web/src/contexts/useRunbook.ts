/**
 * # Runbook Context Hooks
 * 
 * This file provides React hooks for sharing state between MDX blocks
 * (Inputs, Template, TemplateInline, Command, Check).
 * 
 * ## Core Concepts
 * 
 * ### Inputs
 * When a block (like `<Command>`) references inputs via `inputsId`, it gets
 * access to the user-entered values. The flow is:
 * 
 * 1. **Inputs** blocks collect values from the user and register them to the context
 * 2. **Downstream blocks** (Command, Check, TemplateInline) get inputs for API requests
 * 
 * ### Block Outputs
 * When a Check or Command block executes a script that writes to $RUNBOOK_OUTPUT,
 * those outputs are captured and stored in the context. Downstream blocks can reference
 * these outputs via the `_blocks` namespace in templates:
 * 
 * ```
 * {{ ._blocks.create_account.outputs.account_id }}
 * ```
 * 
 * ## Example Usage
 * 
 * ```tsx
 * // Get inputs for API requests
 * const inputs = useInputs(inputsId)
 * // → [{ name: "region", type: "string", value: "us-west-2" }]
 * 
 * // Convert to values map if needed
 * const values = inputsToValues(inputs)
 * // → { region: "us-west-2" }
 * 
 * // Register outputs after script execution
 * const { registerOutputs } = useRunbook()
 * registerOutputs(blockId, [{ name: "account_id", value: "123456789012" }])
 * ```
 * 
 * @see RunbookContext - The context provider
 */

import { useContext, useMemo, useRef } from 'react'
import { RunbookContext, type RunbookContextType, type InputValue, type OutputValue, type BlockInputs, type BlockOutputs, inputsToValues, valuesToOutputs } from './RunbookContext'

// Re-export types and helpers for convenience
export { type InputValue, type OutputValue, type BlockInputs, type BlockOutputs, inputsToValues, valuesToOutputs } from './RunbookContext'

// Stable empty arrays to avoid creating new references
const EMPTY_INPUTS: InputValue[] = []
const EMPTY_OUTPUTS: OutputValue[] = []
const EMPTY_TEMPLATE_VARS: Record<string, unknown> = { _blocks: {} }

/**
 * Hook to access the full runbook context.
 * Use this when you need to register inputs or outputs.
 */
export function useRunbook(): RunbookContextType {
  const context = useContext(RunbookContext)
  if (!context) {
    throw new Error('useRunbook must be used within a RunbookProvider')
  }
  return context
}

/**
 * Hook to get inputs from one or more inputsIds.
 * Returns an array of { name, type, value } objects suitable for API requests.
 * 
 * Use `inputsToValues(inputs)` if you need a key-value map for lookups.
 * 
 * @param inputsId - One or more IDs to get inputs from
 * @returns Array of Input objects (merged, later IDs override earlier)
 */
export function useInputs(inputsId: string | string[] | undefined): InputValue[] {
  const context = useContext(RunbookContext)
  
  // Get the blockInputs from context to track changes
  const blockInputs = context?.blockInputs
  
  // Track previous result to maintain referential stability
  const prevResultRef = useRef<InputValue[]>(EMPTY_INPUTS)
  
  return useMemo(() => {
    if (!context || !inputsId) return EMPTY_INPUTS
    
    const newInputs = context.getInputs(inputsId)
    
    // Check if inputs actually changed (compare by JSON since Input has nested value)
    const prevJson = JSON.stringify(prevResultRef.current)
    const newJson = JSON.stringify(newInputs)
    
    if (prevJson === newJson) {
      return prevResultRef.current
    }
    
    prevResultRef.current = newInputs
    return newInputs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, blockInputs])
}

/**
 * Hook to get outputs from a specific block.
 * 
 * @param blockId - The ID of the block whose outputs to get
 * @returns The block's outputs, or undefined if no outputs exist
 */
export function useOutputs(blockId: string | undefined): OutputValue[] | undefined {
  const context = useContext(RunbookContext)
  
  // Get the blockOutputs from context to track changes
  const blockOutputs = context?.blockOutputs
  
  return useMemo(() => {
    if (!context || !blockId) return undefined
    return context.getOutputs(blockId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, blockOutputs])
}

/**
 * Hook to get all block outputs.
 * Returns the entire blockOutputs map for use in dependency tracking.
 */
export function useAllOutputs(): Record<string, BlockOutputs> {
  const context = useContext(RunbookContext)
  return context?.blockOutputs ?? {}
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
 * //     "create_account": { outputs: { account_id: "123456789012" } }
 * //   }
 * // }
 * const templateVars = useTemplateVariables("aws-config");
 */
export function useTemplateVariables(inputsId?: string | string[]): Record<string, unknown> {
  const context = useContext(RunbookContext)
  
  // Track both inputs and outputs for re-renders
  const blockInputs = context?.blockInputs
  const blockOutputs = context?.blockOutputs
  
  return useMemo(() => {
    if (!context) return EMPTY_TEMPLATE_VARS
    return context.getTemplateVariables(inputsId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, blockInputs, blockOutputs])
}
