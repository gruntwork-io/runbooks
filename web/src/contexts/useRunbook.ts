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
 * these outputs via the `outputs` namespace in templates:
 *
 * ```
 * {{ .outputs.create_account.account_id }}
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
 * const values = flattenInputs(inputs)
 * // → { region: "us-west-2" }
 *
 * // Register outputs after script execution
 * const { registerOutputs } = useRunbookContext()
 * registerOutputs(blockId, [{ name: "account_id", value: "123456789012" }])
 * ```
 *
 * @see RunbookContext - The context provider
 */

import { useContext, useMemo, useRef } from 'react'
import { RunbookContext, type RunbookContextType, type TemplateValue, type OutputValue, type BlockOutputs } from './RunbookContext'
import type { TemplateContext } from '@/lib/templateUtils'

// Re-export types and helpers for convenience
export { type TemplateValue, type OutputValue, type BlockInputs, type BlockOutputs, flattenInputs, valuesToOutputs } from './RunbookContext'

// Stable empty arrays to avoid creating new references
const EMPTY_INPUTS: TemplateValue[] = []
const EMPTY_TEMPLATE_CONTEXT: TemplateContext = { inputs: {}, outputs: {} }

/**
 * Hook to access the full runbook context.
 * Use this when you need to register inputs or outputs.
 */
export function useRunbookContext(): RunbookContextType {
  const context = useContext(RunbookContext)
  if (!context) {
    throw new Error('useRunbookContext must be used within a RunbookContextProvider')
  }
  return context
}

/**
 * Hook to get inputs from one or more inputsIds.
 * Returns an array of { name, type, value } objects suitable for API requests.
 *
 * Use `flattenInputs(inputs)` if you need a key-value map for lookups.
 *
 * @param inputsId - One or more IDs to get inputs from
 * @returns Array of TemplateValue objects (merged, later IDs override earlier)
 */
export function useInputs(inputsId: string | string[] | undefined): TemplateValue[] {
  const context = useContext(RunbookContext)

  // Get the blockInputs from context to track changes
  const blockInputs = context?.blockInputs

  // Track previous result to maintain referential stability
  const prevResultRef = useRef<TemplateValue[]>(EMPTY_INPUTS)

  return useMemo(() => {
    if (!context || !inputsId) return EMPTY_INPUTS

    const newInputs = context.getInputs(inputsId)

    // Check if inputs actually changed (compare by JSON since TemplateValue has nested value)
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
 * Hook to get the full template context for rendering.
 *
 * Returns a `TemplateContext` with two namespaces:
 * - `inputs`: merged input values from the specified `inputsId` block(s)
 * - `outputs`: flattened outputs from ALL blocks (outputs are global)
 *
 * @example
 * const ctx = useTemplateContext("aws-config")
 * // → { inputs: { region: "us-west-2" }, outputs: { create_account: { account_id: "123" } } }
 */
export function useTemplateContext(inputsId?: string | string[]): TemplateContext {
  const context = useContext(RunbookContext)

  // Track both inputs and outputs for re-renders
  const blockInputs = context?.blockInputs
  const blockOutputs = context?.blockOutputs

  return useMemo(() => {
    if (!context) return EMPTY_TEMPLATE_CONTEXT
    return context.getTemplateContext(inputsId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsId, blockInputs, blockOutputs])
}
