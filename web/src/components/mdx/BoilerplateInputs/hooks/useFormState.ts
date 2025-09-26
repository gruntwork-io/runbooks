import { useState, useEffect, useCallback } from 'react'
import type { BoilerplateConfig, BoilerplateVariable } from '../BoilerplateInputs.types'

/**
 * Custom hook for managing form state and data flow
 * 
 * @param boilerplateConfig - The boilerplate configuration containing variable definitions
 * @param initialData - Initial form data values
 * @param onFormChange - Optional callback when form data changes
 * @returns Object containing form state and update methods
 */
export const useFormState = (
  boilerplateConfig: BoilerplateConfig | null,
  initialData: Record<string, unknown> = {},
  onFormChange?: (formData: Record<string, unknown>) => void
) => {
  const [formData, setFormData] = useState<Record<string, unknown>>({})

  // Initialize form data with defaults and initial values
  useEffect(() => {
    if (!boilerplateConfig) return
    
    const initialFormData: Record<string, unknown> = {}
    
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      initialFormData[variable.name] = initialData[variable.name] ?? variable.default
    })
    
    setFormData(initialFormData)
  }, [boilerplateConfig, initialData])

  // Notify parent component when form data changes
  useEffect(() => {
    if (onFormChange) {
      onFormChange(formData)
    }
  }, [formData, onFormChange])

  /**
   * Updates a specific form field value
   * @param fieldName - Name of the field to update
   * @param value - New value for the field
   */
  const updateField = useCallback((fieldName: string, value: unknown) => {
    setFormData(prev => ({
      ...prev,
      [fieldName]: value
    }))
  }, [])

  /**
   * Resets the form to default values from the boilerplate configuration
   */
  const resetForm = useCallback(() => {
    if (!boilerplateConfig) return
    
    const resetData: Record<string, unknown> = {}
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      resetData[variable.name] = variable.default
    })
    
    setFormData(resetData)
  }, [boilerplateConfig])

  return {
    formData,
    updateField,
    resetForm
  }
}
