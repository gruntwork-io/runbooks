/**
 * @deprecated This function is no longer used. Command/Check now use useInputValues from BlockVariablesContext.
 * TODO: Remove this file and its tests when cleaning up legacy code.
 * 
 * Merges variables from multiple Inputs components.
 * Variables are merged in order, with later IDs overriding earlier ones.
 * Inline variables (if provided) have the highest precedence.
 * 
 * @param inputsId - Single ID or array of IDs to merge variables from
 * @param variablesByInputsId - Map of inputsId to their variable values (the actual values entered by the user)
 * @param inlineInputsId - Optional ID for inline variables (highest precedence)
 * @returns Merged variables object
 */
export function mergeBoilerplateVariables(
  inputsId: string | string[] | undefined,
  variablesByInputsId: Record<string, Record<string, unknown>>,
  inlineInputsId?: string | null
): Record<string, unknown> {
  // Normalize inputsId to array
  const inputsIds = inputsId 
    ? (Array.isArray(inputsId) ? inputsId : [inputsId])
    : []
  
  // Merge variables from each inputsId in order (later overrides earlier)
  const mergedExternalVars = inputsIds.reduce((acc, id) => {
    const vars = variablesByInputsId[id]
    return vars ? { ...acc, ...vars } : acc
  }, {} as Record<string, unknown>)
  
  // Inline variables have highest precedence
  const inlineVars = inlineInputsId ? variablesByInputsId[inlineInputsId] : undefined
  
  return {
    ...mergedExternalVars,
    ...(inlineVars || {})
  }
}

