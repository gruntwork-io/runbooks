import { useState, useCallback } from 'react'
import type { BoilerplateConfig, BoilerplateVariable } from '../BoilerplateInputs.types'
import { formatVariableLabel } from '../lib/formatVariableLabel'

/**
 * Interface for validation error messages
 */
interface ValidationErrors {
  [key: string]: string
}

/**
 * Custom hook for managing form validation state and logic
 * 
 * @param boilerplateConfig - The boilerplate configuration containing variable definitions
 * @returns Object containing validation state and methods
 */
export const useFormValidation = (boilerplateConfig: BoilerplateConfig | null) => {
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({})

  /**
   * Validates the entire form against the boilerplate configuration
   * @param formData - Current form data to validate
   * @returns True if form is valid, false otherwise
   */
  const validateForm = useCallback((formData: Record<string, unknown>): boolean => {
    if (!boilerplateConfig) return false
    
    const errors: ValidationErrors = {}
    let isValid = true
    
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      const value = formData[variable.name]
      
      // Required field validation
      if (variable.required && (value === undefined || value === null || value === '')) {
        errors[variable.name] = `${formatVariableLabel(variable.name)} is required`
        isValid = false
      }
      
      // TODO: Add more validation rules based on variable.validations
      // This could include URL validation, email validation, etc.
    })
    
    setValidationErrors(errors)
    return isValid
  }, [boilerplateConfig])

  /**
   * Clears validation error for a specific field
   * @param fieldName - Name of the field to clear error for
   */
  const clearFieldError = useCallback((fieldName: string) => {
    setValidationErrors(prev => {
      if (prev[fieldName]) {
        const newErrors = { ...prev }
        delete newErrors[fieldName]
        return newErrors
      }
      return prev
    })
  }, [])

  /**
   * Clears all validation errors
   */
  const clearAllErrors = useCallback(() => {
    setValidationErrors({})
  }, [])

  return {
    validationErrors,
    validateForm,
    clearFieldError,
    clearAllErrors
  }
}
