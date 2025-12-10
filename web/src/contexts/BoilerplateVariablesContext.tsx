import { useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { BoilerplateVariablesContext } from './BoilerplateVariablesContext.types'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

/**
 * Provider component that enables variable sharing between BoilerplateInputs and BoilerplateTemplate components.
 * 
 * Wrap your MDX content with this provider to allow multiple form/template pairs to communicate.
 * Each pair is isolated by their unique ID, so multiple instances can coexist without conflicts.
 * 
 * We use this context to share variable values between Inputs and BoilerplateTemplate components.
 * 
 * @example
 * <BoilerplateVariablesProvider>
 *   <Inputs id="form1">...</Inputs>
 *   <BoilerplateTemplate inputsId="form1">...</BoilerplateTemplate>
 *   
 *   <Inputs id="form2">...</Inputs>
 *   <BoilerplateTemplate inputsId="form2">...</BoilerplateTemplate>
 * </BoilerplateVariablesProvider>
 */
export function BoilerplateVariablesProvider({ children }: { children: ReactNode }) {
  const [variablesByInputsId, setVariablesByInputsId] = useState<Record<string, Record<string, unknown>>>({})
  const [configsByInputsId, setConfigsByInputsId] = useState<Record<string, BoilerplateConfig>>({})
  const [yamlContentByInputsId, setYamlContentByInputsId] = useState<Record<string, string>>({})

  const setVariables = useCallback((inputsId: string, variables: Record<string, unknown>) => {
    console.log(`[BoilerplateVariablesContext] setVariables called for [${inputsId}]:`, variables);
    setVariablesByInputsId(prev => {
      const updated = {
        ...prev,
        [inputsId]: variables
      };
      console.log(`[BoilerplateVariablesContext] Updated variablesByInputsId:`, updated);
      return updated;
    })
  }, [])

  const getVariables = useCallback((inputsId: string) => {
    return variablesByInputsId[inputsId]
  }, [variablesByInputsId])

  const setConfig = useCallback((inputsId: string, config: BoilerplateConfig) => {
    setConfigsByInputsId(prev => ({
      ...prev,
      [inputsId]: config
    }))
  }, [])

  const getConfig = useCallback((inputsId: string) => {
    return configsByInputsId[inputsId]
  }, [configsByInputsId])

  const setYamlContent = useCallback((inputsId: string, yamlContent: string) => {
    setYamlContentByInputsId(prev => ({
      ...prev,
      [inputsId]: yamlContent
    }))
  }, [])

  const getYamlContent = useCallback((inputsId: string) => {
    return yamlContentByInputsId[inputsId]
  }, [yamlContentByInputsId])

  const contextValue = useMemo(() => ({
    variablesByInputsId, 
    configsByInputsId,
    yamlContentByInputsId,
    setVariables, 
    getVariables,
    setConfig,
    getConfig,
    setYamlContent,
    getYamlContent
  }), [variablesByInputsId, configsByInputsId, yamlContentByInputsId, setVariables, getVariables, setConfig, getConfig, setYamlContent, getYamlContent]);

  return (
    <BoilerplateVariablesContext value={contextValue}>
      {children}
    </BoilerplateVariablesContext>
  )
}
