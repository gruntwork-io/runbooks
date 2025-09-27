import React from 'react'
import { Button } from '@/components/ui/button'
import type { BoilerplateVariable, BoilerplateInputsFormProps } from './BoilerplateInputs.types'
import { formatVariableLabel } from './lib/formatVariableLabel'
import { FormControl } from './components/FormControls'
import { useFormState } from './hooks/useFormState'
import { useFormValidation } from './hooks/useFormValidation'
import { SuccessIndicator } from './components/SuccessIndicator'

/**
 * Main form component for rendering a webform to initialize boilerplate variables
 * 
 * This component renders a form with appropriate input controls based on the
 * boilerplate variable types. It handles form state, validation, and submission.
 * 
 * @param props - Form configuration object containing:
 *   - `id`: Unique identifier for the form
 *   - `boilerplateConfig`: Variable definitions and types to render
 *   - `initialData`: Optional pre-filled values for form fields
 *   - `onFormChange`: Optional callback when form data changes
 *   - `onSubmit`: Optional callback when form is submitted
 *   - `submitButtonText`: Text for the submit button (default: 'Generate')
 *   - `showSubmitButton`: Whether to show submit button (default: true)
 *   - `isGenerating`: Whether form is in loading state (default: false)
 *   - `hasGeneratedSuccessfully`: Whether to show success message (default: false)
 * @returns JSX element representing the form
 */
export const BoilerplateInputsForm: React.FC<BoilerplateInputsFormProps> = ({
  id,
  boilerplateConfig,
  initialData = {},
  onFormChange,
  onAutoRender,
  onSubmit,
  submitButtonText = 'Generate',
  showSubmitButton = true,
  isGenerating = false,
  isAutoRendering = false,
  showSuccessIndicator = false,
  enableAutoRender = true,
  hasGeneratedSuccessfully = false
}) => {
  // Use custom hooks for state management and validation
  const { formData, updateField } = useFormState(boilerplateConfig, initialData, onFormChange, onAutoRender, enableAutoRender)
  const { validationErrors, validateForm, clearFieldError } = useFormValidation(boilerplateConfig)

  /**
   * Handles form input changes and clears validation errors
   * @param variableName - Name of the variable being changed
   * @param value - New value for the variable
   */
  const handleInputChange = (variableName: string, value: unknown) => {
    updateField(variableName, value)
    clearFieldError(variableName)
  }

  /**
   * Handles form submission with validation
   * @param e - Form submission event
   */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!validateForm(formData)) {
      return
    }
    
    if (onSubmit) {
      onSubmit(formData)
    }
  }


  return (
    <div className="p-6 border border-gray-200 rounded-lg shadow-sm bg-gray-100 relative">
      
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-5">
          {boilerplateConfig!.variables.map((variable: BoilerplateVariable) => (
            <div key={variable.name} className="space-y-1">
              <label 
                htmlFor={`${id}-${variable.name}`}
                className="block text-md font-medium text-gray-700"
              >
                {formatVariableLabel(variable.name)}
                {variable.required && <span className="text-gray-400 ml-1">*</span>}
              </label>
              
              <FormControl
                variable={variable}
                value={formData[variable.name]}
                error={validationErrors[variable.name]}
                onChange={(value) => handleInputChange(variable.name, value)}
                id={id}
              />

              {variable.description && (
                <p className="text-sm text-gray-400">{variable.description}</p>
              )}
              
              {validationErrors[variable.name] && (
                <p className="text-sm text-red-600">{validationErrors[variable.name]}</p>
              )}
            </div>
          ))}
        </div>
        
        {showSubmitButton && (
          <div>
            <div className="pt-4 border-t border-gray-200 flex items-center gap-2">
              <Button
                type="submit"
                variant="default"
                disabled={isGenerating || isAutoRendering}
              >
                {submitButtonText}
              </Button>
              <SuccessIndicator 
                show={showSuccessIndicator} 
                className="ml-2" 
              />
            </div>
            {hasGeneratedSuccessfully && (
              <div className="text-sm text-gray-400 mt-3 italic">
                You can now update the fields above and the generated files will automatically update.
              </div>
            )}
          </div>
        )}
      </form>
    </div>
  )
}
