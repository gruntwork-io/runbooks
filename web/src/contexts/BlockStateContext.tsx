/* eslint-disable react-refresh/only-export-components */
import { createContext, useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'

/**
 * Data stored for each registered Inputs component.
 * - We need the variable values the user entered
 * - We also need the boilerplate.yml config underlying the variables so that any consuming
 *   templates know how to render the boilerplate template!
 */
export interface InputsData {
  /** Variable values entered by the user */
  values: Record<string, unknown>
  /** Parsed boilerplate configuration (schema) */
  config: BoilerplateConfig
}

/**
 * Data stored for each block's outputs.
 * Outputs are key-value pairs produced by Check/Command blocks via $RUNBOOK_OUTPUT.
 */
export interface Outputs {
  /** The key-value pairs from script */
  values: Record<string, string>
  /** When outputs were captured */
  timestamp: string
}

/**
 * Context interface for sharing state between blocks.
 * 
 * - Inputs components register their values and config.
 * - Check/Command blocks register their outputs after execution.
 * - TemplateInline, Command, and Check components consume merged values/configs.
 */
export interface BlockStateContextType {
  /** All registered inputs data, keyed by inputsId */
  inputs: Record<string, InputsData>
  
  /** Register or update an Inputs component's data */
  registerInputs: (id: string, values: Record<string, unknown>, config: BoilerplateConfig) => void
  
  /** Get merged input values from one or more inputsIds (later IDs override earlier) */
  getInputValues: (inputsId: string | string[]) => Record<string, unknown>
  
  /** Get merged config from one or more inputsIds (later IDs override on variable name conflicts) */
  getConfig: (inputsId: string | string[]) => BoilerplateConfig
  
  /** Generate a boilerplate.yml string from merged config */
  generateYaml: (inputsId: string | string[]) => string
  
  /** All registered block outputs, keyed by blockId */
  outputs: Record<string, Outputs>
  
  /** Register or replace a block's outputs (completely replaces previous outputs) */
  registerOutputs: (blockId: string, outputValues: Record<string, string>) => void
  
  /** Get outputs for a specific block */
  getOutputValues: (blockId: string) => Record<string, string> | undefined
  
  /** 
   * Get template variables for rendering.
   * Returns input values spread at root level, plus _blocks namespace with all block outputs.
   * 
   * @example
   * // Returns: { region: "us-west-2", _blocks: { "create-account": { outputs: { account_id: "123" } } } }
   * getTemplateVariables("aws-config")
   */
  getTemplateVariables: (inputsId?: string | string[]) => Record<string, unknown>
}

export const BlockStateContext = createContext<BlockStateContextType | undefined>(undefined)

/**
 * Provider component that enables state sharing between blocks.
 * - Inputs register their values
 * - Check/Command blocks register their outputs
 * - Templates consume both via getTemplateVariables
 * 
 * @example
 * <BlockStateProvider>
 *   <Inputs id="config-a">...</Inputs>
 *   <Command id="create-account" ... />
 *   <Command inputsId="config-a" command="echo {{ ._blocks.create-account.outputs.account_id }}" />
 * </BlockStateProvider>
 */
export function BlockStateProvider({ children }: { children: ReactNode }) {
  const [inputs, setInputs] = useState<Record<string, InputsData>>({})
  const [outputs, setOutputs] = useState<Record<string, Outputs>>({})

  const registerInputs = useCallback((id: string, values: Record<string, unknown>, config: BoilerplateConfig) => {
    setInputs(prev => {
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
      
      console.log(`[BlockStateContext] registerInputs updating [${id}]:`, { values, config })
      return {
        ...prev,
        [id]: { values, config }
      }
    })
  }, [])

  const getInputValues = useCallback((inputsId: string | string[]): Record<string, unknown> => {
    const ids = Array.isArray(inputsId) ? inputsId : [inputsId]
    // Merge values from all inputsIds, later IDs override earlier ones
    return ids.reduce((acc, id) => {
      const data = inputs[id]
      return data ? { ...acc, ...data.values } : acc
    }, {} as Record<string, unknown>)
  }, [inputs])

  const getConfig = useCallback((inputsId: string | string[]): BoilerplateConfig => {
    const ids = Array.isArray(inputsId) ? inputsId : [inputsId]
    
    // Collect all variables from all configs
    const allVariables: BoilerplateVariable[] = []
    for (const id of ids) {
      const data = inputs[id]
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
      variables: Array.from(variableMap.values()),
      rawYaml: '' // Will be regenerated by generateYaml
    }
  }, [inputs])

  const generateYaml = useCallback((inputsId: string | string[]): string => {
    const config = getConfig(inputsId)
    
    if (!config.variables || config.variables.length === 0) {
      return 'variables: []'
    }
    
    // Generate minimal YAML for boilerplate
    const lines = ['variables:']
    for (const variable of config.variables) {
      lines.push(`  - name: ${variable.name}`)
      lines.push(`    type: ${variable.type || 'string'}`)
      if (variable.description) {
        lines.push(`    description: "${variable.description.replace(/"/g, '\\"')}"`)
      }
      if (variable.default !== undefined) {
        if (typeof variable.default === 'string') {
          lines.push(`    default: "${variable.default.replace(/"/g, '\\"')}"`)
        } else {
          lines.push(`    default: ${JSON.stringify(variable.default)}`)
        }
      }
      if (variable.options && variable.options.length > 0) {
        lines.push(`    options:`)
        for (const option of variable.options) {
          lines.push(`      - ${option}`)
        }
      }
    }
    
    return lines.join('\n')
  }, [getConfig])

  const registerOutputs = useCallback((blockId: string, outputValues: Record<string, string>) => {
    // Normalize block ID: hyphens → underscores (Go templates don't support hyphens in dot notation)
    const normalizedId = blockId.replace(/-/g, '_')
    console.log(`[BlockStateContext] registerOutputs [${blockId} → ${normalizedId}]:`, outputValues)
    setOutputs(prev => ({
      ...prev,
      [normalizedId]: {
        values: outputValues,
        timestamp: new Date().toISOString()
      }
    }))
  }, [])

  const getOutputValues = useCallback((blockId: string): Record<string, string> | undefined => {
    // Normalize block ID for lookup
    const normalizedId = blockId.replace(/-/g, '_')
    return outputs[normalizedId]?.values
  }, [outputs])

  const getTemplateVariables = useCallback((inputsId?: string | string[]): Record<string, unknown> => {
    // 1. Spread input values at root level (backward compatible)
    const vars: Record<string, unknown> = inputsId 
      ? getInputValues(inputsId) 
      : {}
    
    // 2. Build _blocks namespace with all block outputs
    // Note: Block IDs are already normalized when stored (hyphens → underscores)
    // because Go templates interpret hyphens as subtraction operators in dot notation.
    // e.g., {{ ._blocks.create-account.outputs.x }} would fail, but
    //       {{ ._blocks.create_account.outputs.x }} works correctly.
    const blocksNamespace: Record<string, { outputs: Record<string, string> }> = {}
    for (const [blockId, data] of Object.entries(outputs)) {
      blocksNamespace[blockId] = {
        outputs: data.values
      }
    }
    vars._blocks = blocksNamespace
    
    return vars
  }, [getInputValues, outputs])

  const contextValue = useMemo(() => ({
    inputs,
    registerInputs,
    getInputValues,
    getConfig,
    generateYaml,
    outputs,
    registerOutputs,
    getOutputValues,
    getTemplateVariables,
  }), [inputs, registerInputs, getInputValues, getConfig, generateYaml, outputs, registerOutputs, getOutputValues, getTemplateVariables])

  return (
    <BlockStateContext.Provider value={contextValue}>
      {children}
    </BlockStateContext.Provider>
  )
}

// Hooks are in a separate file to satisfy react-refresh requirements
// See: useBlockState.ts
