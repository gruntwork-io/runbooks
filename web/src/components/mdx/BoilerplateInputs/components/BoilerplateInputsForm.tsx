import React, { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import { formatVariableLabel } from '@/components/mdx/BoilerplateInputs/lib/formatVariableLabel'
import { FormControl } from './FormControls'
import { useFormState } from '@/components/mdx/BoilerplateInputs/hooks/useFormState'
import { useFormValidation } from '@/components/mdx/BoilerplateInputs/hooks/useFormValidation'
import { SuccessIndicator } from '@/components/mdx/BoilerplateInputs/components/SuccessIndicator'

/**
 * Main form component for rendering a webform to initialize boilerplate variables
 * 
 * This component renders a form with appropriate input controls based on the
 * boilerplate variable types. It handles form state, validation, and submission.
 * Variables can be grouped into sections using the x-section YAML property.
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
interface BoilerplateInputsFormProps {
  id: string
  boilerplateConfig: BoilerplateConfig | null
  initialData?: Record<string, unknown>
  onFormChange?: (formData: Record<string, unknown>) => void
  onAutoRender?: (formData: Record<string, unknown>) => void
  onGenerate?: (formData: Record<string, unknown>) => void
  submitButtonText?: string
  showSubmitButton?: boolean
  isGenerating?: boolean
  isAutoRendering?: boolean
  showSuccessIndicator?: boolean
  enableAutoRender?: boolean
  hasGeneratedSuccessfully?: boolean
  variant?: 'standard' | 'embedded'
  /** When true, uses inline YAML mode which updates variables instead of generating files */
  isInlineMode?: boolean
}

/**
 * Renders a single variable field with label, input control, description, and validation error
 */
interface VariableFieldProps {
  id: string
  variable: BoilerplateVariable
  value: unknown
  error?: string
  onChange: (value: unknown) => void
}

const VariableField: React.FC<VariableFieldProps> = ({ id, variable, value, error, onChange }) => (
  <div className="space-y-1">
    <label 
      htmlFor={`${id}-${variable.name}`}
      className="block text-md font-medium text-gray-700"
    >
      {formatVariableLabel(variable.name)}
      {variable.required && <span className="text-gray-400 ml-1">*</span>}
    </label>
    
    <FormControl
      variable={variable}
      value={value}
      error={error}
      onChange={onChange}
      id={id}
    />

    {variable.description && (
      <p className="text-sm text-gray-400">{variable.description}</p>
    )}
    
    {error && (
      <p className="text-sm text-red-600">{error}</p>
    )}
  </div>
)

export const BoilerplateInputsForm: React.FC<BoilerplateInputsFormProps> = ({
  id,
  boilerplateConfig,
  initialData = {},
  onFormChange,
  onAutoRender,
  onGenerate,
  submitButtonText,
  showSubmitButton = true,
  isGenerating = false,
  isAutoRendering = false,
  showSuccessIndicator = false,
  enableAutoRender = true,
  hasGeneratedSuccessfully = false,
  variant = 'standard',
  isInlineMode = false
}) => {
  // Default button text depends on mode
  const effectiveButtonText = submitButtonText ?? (isInlineMode ? 'Submit' : 'Generate')
  // Use custom hooks for state management and validation
  const { formData, updateField } = useFormState(boilerplateConfig, initialData, onFormChange, onAutoRender, enableAutoRender)
  const { validationErrors, validateForm, clearFieldError } = useFormValidation(boilerplateConfig)

  // Create a map of variable name to variable for quick lookup
  const variablesByName = useMemo(() => {
    if (!boilerplateConfig) return new Map<string, BoilerplateVariable>()
    return new Map(boilerplateConfig.variables.map(v => [v.name, v]))
  }, [boilerplateConfig])

  // Determine if we should use section-based rendering
  const hasSections = boilerplateConfig?.sections && boilerplateConfig.sections.length > 0

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

    console.log('formData', formData)
    console.log('validateForm', validateForm(formData))
    
    if (!validateForm(formData)) {
      return
    }
    
    if (onGenerate) {
      onGenerate(formData)
    }
  }

  /**
   * Renders variables for a given section
   */
  const renderSectionVariables = (variableNames: string[]) => {
    return variableNames.map(varName => {
      const variable = variablesByName.get(varName)
      if (!variable) return null
      return (
        <VariableField
          key={variable.name}
          id={id}
          variable={variable}
          value={formData[variable.name]}
          error={validationErrors[variable.name]}
          onChange={(value) => handleInputChange(variable.name, value)}
        />
      )
    })
  }

  /**
   * Renders all variables grouped by sections
   */
  const renderWithSections = () => {
    if (!boilerplateConfig?.sections) return null
    
    return boilerplateConfig.sections.map((section) => {
      if (section.variables.length === 0) return null

      // For unnamed section (empty string), don't render a header
      if (section.name === '') {
        return (
          <div key="__unsectioned__" className="space-y-5">
            {renderSectionVariables(section.variables)}
          </div>
        )
      }

      // For named sections, render with a header
      return (
        <div key={section.name} className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-800 pt-5 pb-1 border-b border-gray-400">
            {section.name}
          </h3>
          <div className="space-y-5">
            {renderSectionVariables(section.variables)}
          </div>
        </div>
      )
    })
  }

  /**
   * Renders all variables without sections (fallback for configs without sections)
   */
  const renderWithoutSections = () => {
    return boilerplateConfig!.variables.map((variable: BoilerplateVariable) => (
      <VariableField
        key={variable.name}
        id={id}
        variable={variable}
        value={formData[variable.name]}
        error={validationErrors[variable.name]}
        onChange={(value) => handleInputChange(variable.name, value)}
      />
    ))
  }

  // Determine container classes and whether to show submit button based on variant
  const containerClasses = variant === 'embedded' 
    ? 'bg-transparent relative'
    : 'p-6 border border-gray-200 rounded-lg shadow-sm bg-gray-100 mb-4 relative';
  
  const shouldShowSubmitButton = variant === 'embedded' ? false : showSubmitButton;

  return (
    <div className={containerClasses}>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-5">
          {hasSections ? renderWithSections() : renderWithoutSections()}
        </div>
        
        {shouldShowSubmitButton && (
          <div>
            <div className="pt-4 border-t border-gray-200 flex items-center gap-2">
              <Button
                type="submit"
                variant="default"
                disabled={isGenerating || isAutoRendering}
              >
                {effectiveButtonText}
              </Button>
              <SuccessIndicator 
                show={showSuccessIndicator} 
                className="ml-2" 
              />
            </div>
            {hasGeneratedSuccessfully && (
              <div className="text-sm text-gray-400 mt-3 italic">
                {isInlineMode 
                  ? 'You can now update the fields above and the variable values will automatically update.'
                  : 'You can now update the fields above and the generated files will automatically update.'}
              </div>
            )}
          </div>
        )}
      </form>
    </div>
  )
}
