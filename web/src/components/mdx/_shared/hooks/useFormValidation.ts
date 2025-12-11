import { useState, useCallback, useMemo } from 'react'
import { formatVariableLabel } from '../lib/formatVariableLabel'
import { applyValidationRule } from '../lib/validators'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'

/**
 * Interface for validation error messages
 */
interface ValidationErrors {
  [key: string]: string
}

/**
 * Interface for tracking which fields have been touched (interacted with)
 */
interface TouchedFields {
  [key: string]: boolean
}

/**
 * Custom hook for managing form validation state and logic
 * 
 * Supports two validation modes:
 * 1. On-blur validation: Shows errors only for fields the user has interacted with
 * 2. On-submit validation: Shows all errors when the form is submitted
 * 
 * @param boilerplateConfig - The boilerplate configuration containing variable definitions
 * @returns Object containing validation state and methods
 */
export const useFormValidation = (boilerplateConfig: BoilerplateConfig | null) => {
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({})
  const [touchedFields, setTouchedFields] = useState<TouchedFields>({})

  /**
   * Creates a map of variable name to variable for quick lookup
   */
  const variablesByName = useMemo(() => {
    if (!boilerplateConfig) return new Map<string, BoilerplateVariable>()
    return new Map(boilerplateConfig.variables.map(v => [v.name, v]))
  }, [boilerplateConfig])

  /**
   * Validates a single field value against its variable definition
   * @param fieldName - Name of the field to validate
   * @param value - Current value of the field
   * @returns Error message if invalid, undefined if valid
   */
  const getFieldError = useCallback((fieldName: string, value: unknown): string | undefined => {
    const variable = variablesByName.get(fieldName)
    if (!variable) return undefined

    const stringValue = value === undefined || value === null ? '' : String(value)

    // Required field validation (checked first)
    if (variable.required && (value === undefined || value === null || value === '')) {
      return `${formatVariableLabel(variable.name)} is required`
    }

    // Apply additional validation rules from the variable definition
    if (variable.validations && variable.validations.length > 0) {
      for (const rule of variable.validations) {
        const error = applyValidationRule(stringValue, rule)
        if (error) {
          return error
        }
      }
    }

    return undefined
  }, [variablesByName])

  /**
   * Validates a single field and updates the error state
   * @param fieldName - Name of the field to validate
   * @param value - Current value of the field
   */
  const validateField = useCallback((fieldName: string, value: unknown): void => {
    const error = getFieldError(fieldName, value)
    
    setValidationErrors(prev => {
      if (error) {
        return { ...prev, [fieldName]: error }
      } else {
        const newErrors = { ...prev }
        delete newErrors[fieldName]
        return newErrors
      }
    })
  }, [getFieldError])

  /**
   * Marks a field as touched (user has interacted with it)
   * @param fieldName - Name of the field to mark as touched
   */
  const markFieldTouched = useCallback((fieldName: string) => {
    setTouchedFields(prev => {
      if (prev[fieldName]) return prev
      return { ...prev, [fieldName]: true }
    })
  }, [])

  /**
   * Marks all fields as touched (typically called on form submission)
   */
  const markAllFieldsTouched = useCallback(() => {
    if (!boilerplateConfig) return
    
    const allTouched: TouchedFields = {}
    boilerplateConfig.variables.forEach((variable) => {
      allTouched[variable.name] = true
    })
    setTouchedFields(allTouched)
  }, [boilerplateConfig])

  /**
   * Checks if the form is valid without updating error state
   * Useful for determining status indicator state during auto-render
   * @param formData - Current form data to validate
   * @returns True if form is valid, false otherwise
   */
  const isFormValid = useCallback((formData: Record<string, unknown>): boolean => {
    if (!boilerplateConfig) return false
    
    for (const variable of boilerplateConfig.variables) {
      const error = getFieldError(variable.name, formData[variable.name])
      if (error) return false
    }
    
    return true
  }, [boilerplateConfig, getFieldError])

  /**
   * Validates the entire form against the boilerplate configuration
   * Also marks all fields as touched to show all errors
   * @param formData - Current form data to validate
   * @returns True if form is valid, false otherwise
   */
  const validateForm = useCallback((formData: Record<string, unknown>): boolean => {
    if (!boilerplateConfig) return false
    
    // Mark all fields as touched on form submission
    markAllFieldsTouched()
    
    const errors: ValidationErrors = {}
    let isValid = true
    
    boilerplateConfig.variables.forEach((variable: BoilerplateVariable) => {
      const error = getFieldError(variable.name, formData[variable.name])
      if (error) {
        errors[variable.name] = error
        isValid = false
      }
    })
    
    setValidationErrors(errors)
    return isValid
  }, [boilerplateConfig, getFieldError, markAllFieldsTouched])

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
   * Clears all validation errors and resets touched state
   */
  const clearAllErrors = useCallback(() => {
    setValidationErrors({})
    setTouchedFields({})
  }, [])

  /**
   * Gets visible validation errors (only for touched fields)
   * Use this to display errors in the UI
   */
  const visibleErrors = useMemo(() => {
    const visible: ValidationErrors = {}
    for (const [fieldName, error] of Object.entries(validationErrors)) {
      if (touchedFields[fieldName]) {
        visible[fieldName] = error
      }
    }
    return visible
  }, [validationErrors, touchedFields])

  /**
   * Checks if there are any validation errors (even for untouched fields)
   */
  const hasErrors = useMemo(() => {
    return Object.keys(validationErrors).length > 0
  }, [validationErrors])

  return {
    validationErrors,
    visibleErrors,
    touchedFields,
    hasErrors,
    validateForm,
    validateField,
    isFormValid,
    markFieldTouched,
    markAllFieldsTouched,
    clearFieldError,
    clearAllErrors
  }
}
