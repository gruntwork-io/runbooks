import { useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { BoilerplateVariablesContext } from './BoilerplateVariablesContext.types'

/**
 * Provider component that enables variable sharing between BoilerplateInputs and BoilerplateTemplate components.
 * 
 * Wrap your MDX content with this provider to allow multiple form/template pairs to communicate.
 * Each pair is isolated by their unique ID, so multiple instances can coexist without conflicts.
 * 
 * We use this context to share variable values between BoilerplateInputs and BoilerplateTemplate components.
 * 
 * @example
 * <BoilerplateVariablesProvider>
 *   <BoilerplateInputs id="form1">...</BoilerplateInputs>
 *   <BoilerplateTemplate boilerplateInputsId="form1">...</BoilerplateTemplate>
 *   
 *   <BoilerplateInputs id="form2">...</BoilerplateInputs>
 *   <BoilerplateTemplate boilerplateInputsId="form2">...</BoilerplateTemplate>
 * </BoilerplateVariablesProvider>
 */
export function BoilerplateVariablesProvider({ children }: { children: ReactNode }) {
  const [variablesByInputsId, setVariablesByInputsId] = useState<Record<string, Record<string, unknown>>>({})

  const setVariables = useCallback((inputsId: string, variables: Record<string, unknown>) => {
    setVariablesByInputsId(prev => ({
      ...prev,
      [inputsId]: variables
    }))
  }, [])

  const getVariables = useCallback((inputsId: string) => {
    return variablesByInputsId[inputsId]
  }, [variablesByInputsId])

  return (
    <BoilerplateVariablesContext value={{ variablesByInputsId, setVariables, getVariables }}>
      {children}
    </BoilerplateVariablesContext>
  )
}
