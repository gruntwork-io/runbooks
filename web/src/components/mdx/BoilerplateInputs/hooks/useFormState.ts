import { useState, useEffect, useCallback, useRef } from 'react'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'

/**
 * Custom hook for managing form state and data flow
 * 
 * @param boilerplateConfig - The boilerplate configuration containing variable definitions
 * @param initialData - Initial form data values
 * @param onFormChange - Optional callback when form data changes
 * @param onAutoRender - Optional callback to trigger re-rendering when form data changes
 * @param enableAutoRender - Whether auto-rendering should be enabled (default: true)
 * @returns Object containing form state and update methods
 */
export const useFormState = (
  boilerplateConfig: BoilerplateConfig | null,
  initialData: Record<string, unknown> = {},
  onFormChange?: (formData: Record<string, unknown>) => void,
  onAutoRender?: (formData: Record<string, unknown>) => void,
  enableAutoRender: boolean = true
) => {
  const [formData, setFormData] = useState<Record<string, unknown>>({})

  // Store latest callback references to avoid stale closures
  const onFormChangeRef = useRef(onFormChange)
  const onAutoRenderRef = useRef(onAutoRender)

  // Update refs when callbacks change
  useEffect(() => {
    onFormChangeRef.current = onFormChange
  }, [onFormChange])

  useEffect(() => {
    onAutoRenderRef.current = onAutoRender
  }, [onAutoRender])

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
    if (onFormChangeRef.current) {
      onFormChangeRef.current(formData)
    }
  }, [formData])

  // Track if this is the initial load
  const [isInitialLoad, setIsInitialLoad] = useState(true)

  // Trigger auto-rendering when form data changes (but not on initial load)
  useEffect(() => {
    // Mark that initial load is complete after first form data is set
    if (Object.keys(formData).length > 0 && isInitialLoad) {
      setIsInitialLoad(false)
      return // Don't trigger auto-render on initial load
    }
    
    // Only trigger auto-render if auto-rendering is enabled, we have form data, and it's not the initial load
    if (enableAutoRender && onAutoRenderRef.current && Object.keys(formData).length > 0 && !isInitialLoad) {
      onAutoRenderRef.current(formData)
    }
  }, [formData, isInitialLoad, enableAutoRender])

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
