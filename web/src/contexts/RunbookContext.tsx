/* eslint-disable react-refresh/only-export-components */

/**
 * RunbookContext - Shared State Management for Runbook Blocks
 * 
 * This context enables communication between different block components in a runbook.
 * It solves the problem of passing data between independently-authored MDX components
 * without requiring explicit prop drilling or global state management.
 * 
 * ## Key Concepts
 * 
 * **Inputs**: User-provided values from `<Inputs>` components. These are form fields
 * that collect configuration (e.g., AWS region, account name). Each Inputs component
 * registers its values and boilerplate config schema under a unique ID.
 * 
 * **Outputs**: Key-value pairs produced by `<Check>` and `<Command>` blocks after
 * execution. Scripts can write to $RUNBOOK_OUTPUT to expose values (e.g., account IDs,
 * resource ARNs) that downstream blocks can consume.
 * 
 * ## Data Flow
 * 
 * 1. `<Inputs id="config">` registers user values → context stores them under "config"
 * 2. `<Command id="create-account" inputsId="config">` executes with those values
 * 3. Script writes `account_id=123` to $RUNBOOK_OUTPUT
 * 4. Command registers outputs → context stores them under "create_account"
 * 5. Later blocks access via `{{ ._blocks.create_account.outputs.account_id }}`
 * 
 * ## Usage in Components
 * 
 * ```tsx
 * const { registerInputs, getInputs } = useRunbookContext()
 * 
 * // Register form values
 * registerInputs("my-form", { region: "us-west-2" }, boilerplateConfig)
 * 
 * // Get inputs for API requests
 * const inputs = getInputs("my-form")
 * // → [{ name: "region", type: "string", value: "us-west-2" }]
 * ```
 */

import { createContext, useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import { normalizeBlockId } from '@/lib/utils'

/**
 * Data stored for each registered Inputs block.
 * - We need the variable values the user entered
 * - We also need the boilerplate.yml config underlying the variables so that any consuming
 *   templates know how to render the boilerplate template!
 */
export interface BlockInputs {
  /** Variable values entered by the user */
  values: Record<string, unknown>
  /** Parsed boilerplate configuration (schema) */
  config: BoilerplateConfig
}

/**
 * An input value with its name, type, and value - used for API requests.
 * This format is sent to the backend so it can properly convert JSON values
 * to the correct Go types (e.g., JSON numbers to int).
 */
export interface InputValue {
  name: string
  type: BoilerplateVariableType
  value: unknown
}

/**
 * An output value with its name and value - produced by Check/Command blocks.
 * Outputs are always strings (written via $RUNBOOK_OUTPUT as key=value pairs).
 */
export interface OutputValue {
  name: string
  value: string
}

/**
 * Data stored for each Command/Check block's outputs, including metadata.
 */
export interface BlockOutputs {
  /** The output values from the script (key-value pairs) */
  values: Record<string, string>
  /** When outputs were captured */
  timestamp: string
}

/**
 * Helper function to convert InputValue[] to a values map.
 * Useful when you need to look up values by name.
 */
export function inputsToValues(inputs: InputValue[]): Record<string, unknown> {
  return Object.fromEntries(inputs.map(i => [i.name, i.value]))
}

/**
 * Helper function to convert a values map to OutputValue[].
 * Useful when you need the array form.
 */
export function valuesToOutputs(values: Record<string, string>): OutputValue[] {
  return Object.entries(values).map(([name, value]) => ({ name, value }))
}

/**
 * Context interface for sharing state between blocks.
 * 
 * - Inputs components register their values and config.
 * - Check/Command blocks register their outputs after execution.
 * - TemplateInline, Command, and Check components consume inputs for API requests.
 */
export interface RunbookContextType {
  /** The runbook name derived from its directory path (e.g., "github-pull-request") */
  runbookName: string | undefined

  /** All registered inputs data, keyed by Inputs block ID */
  blockInputs: Record<string, BlockInputs>

  /** Register or update an Inputs component's data */
  registerInputs: (id: string, values: Record<string, unknown>, config: BoilerplateConfig) => void

  /**
   * Get inputs for API requests.
   * Returns an array of { name, type, value } objects suitable for sending to the backend.
   * The backend uses the type information to properly convert JSON values to Go types.
   */
  getInputs: (inputsId: string | string[]) => InputValue[]

  /** All registered block outputs, keyed by Command/Check block ID */
  blockOutputs: Record<string, BlockOutputs>

  /** Register or replace a block's outputs (completely replaces previous outputs) */
  registerOutputs: (blockId: string, values: Record<string, string>) => void

  /** Get outputs for a specific block */
  getOutputs: (blockId: string) => OutputValue[] | undefined

  /**
   * Get template variables for rendering.
   * Returns input values spread at root level, plus _blocks namespace with all block outputs.
   *
   * @example
   * // Returns: { region: "us-west-2", _blocks: { "create_account": { outputs: { account_id: "123" } } } }
   * getTemplateVariables("aws-config")
   */
  getTemplateVariables: (inputsId?: string | string[]) => Record<string, unknown>
}

export const RunbookContext = createContext<RunbookContextType | undefined>(undefined)

/**
 * Provider component that enables state sharing between blocks.
 * - Inputs register their values
 * - Check/Command blocks register their outputs
 * - Templates consume both via getTemplateVariables
 * 
 * @example
 * <RunbookContextProvider>
 *   <Inputs id="config-a">...</Inputs>
 *   <Command id="create-account" ... />
 *   <Command inputsId="config-a" command="echo {{ ._blocks.create_account.outputs.account_id }}" />
 * </RunbookContextProvider>
 */
export function RunbookContextProvider({ children, runbookName }: { children: ReactNode, runbookName?: string }) {
  const [blockInputs, setBlockInputs] = useState<Record<string, BlockInputs>>({})
  const [blockOutputs, setBlockOutputs] = useState<Record<string, BlockOutputs>>({})

  const registerInputs = useCallback((id: string, values: Record<string, unknown>, config: BoilerplateConfig) => {
    setBlockInputs(prev => {
      const existing = prev[id]
      
      // Check if values actually changed (shallow comparison of values object)
      if (existing) {
        const existingKeys = Object.keys(existing.values)
        const newKeys = Object.keys(values)
        
        // Same number of keys and all values equal
        const valuesUnchanged = existingKeys.length === newKeys.length &&
          existingKeys.every(key => existing.values[key] === values[key])
        
        if (valuesUnchanged) {
          // No change, return previous state to avoid re-render
          return prev
        }
      }
      
      console.log(`[RunbookContext] registerInputs updating [${id}]:`, { values, config })
      return {
        ...prev,
        [id]: { values, config }
      }
    })
  }, [])

  // Internal helper to get merged config (used by getInputs)
  const getConfig = useCallback((inputsId: string | string[]): BoilerplateConfig => {
    const ids = Array.isArray(inputsId) ? inputsId : [inputsId]
    
    // Collect all variables from all configs
    const allVariables: BoilerplateVariable[] = []
    for (const id of ids) {
      const data = blockInputs[id]
      if (data?.config?.variables) {
        allVariables.push(...data.config.variables)
      }
    }
    
    // Dedupe by variable name, keeping the last occurrence (later IDs win)
    const variableMap = new Map<string, BoilerplateVariable>()
    for (const variable of allVariables) {
      variableMap.set(variable.name, variable)
    }
    
    return {
      variables: Array.from(variableMap.values())
    }
  }, [blockInputs])

  // Internal helper to get merged values (used by getInputs and getTemplateVariables)
  const getValues = useCallback((inputsId: string | string[]): Record<string, unknown> => {
    const ids = Array.isArray(inputsId) ? inputsId : [inputsId]
    // Merge values from all inputsIds, later IDs override earlier ones
    return ids.reduce((acc, id) => {
      const data = blockInputs[id]
      return data ? { ...acc, ...data.values } : acc
    }, {} as Record<string, unknown>)
  }, [blockInputs])

  const getInputs = useCallback((inputsId: string | string[]): InputValue[] => {
    const config = getConfig(inputsId)
    const values = getValues(inputsId)

    // Build inputs array from config variables with name, type, and current value
    const configVarNames = new Set<string>()
    const result: InputValue[] = (config.variables || []).map(variable => {
      configVarNames.add(variable.name)
      return {
        name: variable.name,
        type: variable.type || BoilerplateVariableType.String,
        value: values[variable.name]
      }
    })

    // Also include extra values that aren't in the config (e.g., _module namespace
    // injected by TfModule). These are passed through as Map type so the backend
    // can process them as template variables alongside the declared config variables.
    for (const [name, value] of Object.entries(values)) {
      if (!configVarNames.has(name)) {
        result.push({
          name,
          type: BoilerplateVariableType.Map,
          value
        })
      }
    }

    return result
  }, [getConfig, getValues])

  const registerOutputs = useCallback((blockId: string, values: Record<string, string>) => {
    const normalizedId = normalizeBlockId(blockId)
    console.log(`[RunbookContext] registerOutputs [${blockId} → ${normalizedId}]:`, values)
    setBlockOutputs(prev => ({
      ...prev,
      [normalizedId]: {
        values,
        timestamp: new Date().toISOString()
      }
    }))
  }, [])

  const getOutputs = useCallback((blockId: string): OutputValue[] | undefined => {
    const normalizedId = normalizeBlockId(blockId)
    const data = blockOutputs[normalizedId]
    return data ? valuesToOutputs(data.values) : undefined
  }, [blockOutputs])

  const getTemplateVariables = useCallback((inputsId?: string | string[]): Record<string, unknown> => {
    // 1. Spread input values at root level (backward compatible)
    const vars: Record<string, unknown> = inputsId 
      ? getValues(inputsId) 
      : {}
    
    // 2. Build _blocks namespace with all block outputs
    // Note: Block IDs are already normalized when stored (hyphens → underscores)
    // because Go templates interpret hyphens as subtraction operators in dot notation.
    // e.g., {{ ._blocks.create-account.outputs.x }} would fail, but
    //       {{ ._blocks.create_account.outputs.x }} works correctly.
    const blocksNamespace: Record<string, { outputs: Record<string, string> }> = {}
    for (const [blockId, data] of Object.entries(blockOutputs)) {
      blocksNamespace[blockId] = {
        outputs: data.values
      }
    }
    vars._blocks = blocksNamespace
    
    return vars
  }, [getValues, blockOutputs])

  const contextValue = useMemo(() => ({
    runbookName,
    blockInputs,
    registerInputs,
    getInputs,
    blockOutputs,
    registerOutputs,
    getOutputs,
    getTemplateVariables,
  }), [runbookName, blockInputs, registerInputs, getInputs, blockOutputs, registerOutputs, getOutputs, getTemplateVariables])

  return (
    <RunbookContext.Provider value={contextValue}>
      {children}
    </RunbookContext.Provider>
  )
}

// Hooks are in a separate file to satisfy react-refresh requirements
// See: useRunbook.ts for useRunbookContext and other hooks
