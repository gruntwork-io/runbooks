import React, { useMemo, useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import type { BoilerplateVariable } from '@/types/boilerplateVariable'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import { formatVariableLabel } from '../lib/formatVariableLabel'
import { FormControl } from './FormControls'
import { useFormState } from '../hooks/useFormState'
import { useFormValidation } from '../hooks/useFormValidation'
import { FormStatus } from './FormStatus'
import { UnmetOutputDependenciesWarning } from './UnmetOutputDependenciesWarning'
import type { UnmetOutputDependency } from '../hooks/useScriptExecution'

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
  /** 
   * Set of "shared" variable names - variables that exist in BOTH imported sources AND this form.
   * These are displayed as read-only and stay live-synced to imported values.
   */
  sharedVarNames?: Set<string>
  /** Live values for shared variables - these sync in real-time from imported sources */
  liveVarValues?: Record<string, unknown>
  /** Unmet output dependencies - shows warning and disables Generate button */
  unmetOutputDependencies?: UnmetOutputDependency[]
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
  onBlur?: () => void
  disabled?: boolean
}

const VariableField: React.FC<VariableFieldProps> = ({ id, variable, value, error, onChange, onBlur, disabled }) => {
  const isBooleanType = variable.type === 'bool'
  
  return (
    <div className="space-y-1">
      <div className={isBooleanType ? 'flex flex-row-reverse flex-wrap items-center justify-end gap-x-2 gap-y-1 -mb-5' : 'contents space-y-1'}>
        <label 
          htmlFor={`${id}-${variable.name}`}
          className={`${isBooleanType ? 'cursor-pointer' : 'block'} text-md font-medium ${disabled ? 'text-gray-500' : 'text-gray-700'}`}
        >
          {formatVariableLabel(variable.name)}
          {variable.required && !disabled && <span className="text-gray-400 ml-1">*</span>}
          {disabled && <span className="text-gray-400 ml-2 text-sm font-normal">(inherited)</span>}
        </label>
        
        <FormControl
          variable={variable}
          value={value}
          error={error}
          onChange={disabled ? () => {} : onChange}
          onBlur={onBlur}
          id={id}
          disabled={disabled}
        />

        {variable.description && (
          <p className={`text-sm text-gray-400 ${isBooleanType ? 'w-full' : ''}`}>{variable.description}</p>
        )}
        
        {error && !disabled && (
          <p className={`text-sm text-red-600 ${isBooleanType ? 'w-full' : ''}`}>{error}</p>
        )}
      </div>
    </div>
  )
}

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
  enableAutoRender = true,
  hasGeneratedSuccessfully = false,
  variant = 'standard',
  isInlineMode = false,
  sharedVarNames = new Set(),
  liveVarValues = {},
  unmetOutputDependencies = []
}) => {
  // Default button text depends on mode
  const effectiveButtonText = submitButtonText ?? (isInlineMode ? 'Submit' : 'Generate')
  
  // Track whether the form has been generated at least once
  const [hasGenerated, setHasGenerated] = useState(hasGeneratedSuccessfully)
  
  // Use validation hook first so we can use isFormValid in the wrapped callback
  const { 
    visibleErrors, 
    validateForm, 
    validateField, 
    isFormValid,
    markFieldTouched 
  } = useFormValidation(boilerplateConfig)

  // Always call onAutoRender so that variables are published to context
  // This allows Command/Check components to react to empty/invalid values
  // Each consumer (Inputs, Template) handles its own logic appropriately
  
  // Use custom hooks for state management
  const { formData, updateField, updateFields } = useFormState(boilerplateConfig, initialData, onFormChange, onAutoRender, enableAutoRender)
  
  // Sync live variable values when they change (for shared variables)
  // Shared variables are read-only in the form and stay live-synced to imported values
  useEffect(() => {
    if (!sharedVarNames || sharedVarNames.size === 0) return
    if (Object.keys(formData).length === 0) return // Wait for form to initialize
    
    // Build updates only for variables that have actually changed
    const updates: Record<string, unknown> = {}
    for (const varName of sharedVarNames) {
      const liveValue = liveVarValues[varName]
      if (liveValue !== undefined && formData[varName] !== liveValue) {
        updates[varName] = liveValue
      }
    }
    
    // Apply updates if there are any
    if (Object.keys(updates).length > 0) {
      updateFields(updates)
    }
  }, [sharedVarNames, liveVarValues, formData, updateFields])

  // Create a map of variable name to variable for quick lookup
  const variablesByName = useMemo(() => {
    if (!boilerplateConfig) return new Map<string, BoilerplateVariable>()
    return new Map(boilerplateConfig.variables.map(v => [v.name, v]))
  }, [boilerplateConfig])

  // Determine if we should use section-based rendering
  const hasSections = boilerplateConfig?.sections && boilerplateConfig.sections.length > 0

  /**
   * Handles form input changes
   * @param variableName - Name of the variable being changed
   * @param value - New value for the variable
   */
  const handleInputChange = (variableName: string, value: unknown) => {
    updateField(variableName, value)
    // Validate the field on change if it's already been touched
    validateField(variableName, value)
  }

  /**
   * Handles field blur - marks field as touched and validates it
   * @param variableName - Name of the variable that lost focus
   */
  const handleFieldBlur = (variableName: string) => {
    markFieldTouched(variableName)
    validateField(variableName, formData[variableName])
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
    
    // Mark as generated after first successful submission
    setHasGenerated(true)
    
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
      const isDisabled = sharedVarNames.has(variable.name)
      return (
        <VariableField
          key={variable.name}
          id={id}
          variable={variable}
          value={formData[variable.name]}
          error={visibleErrors[variable.name]}
          onChange={(value) => handleInputChange(variable.name, value)}
          onBlur={() => handleFieldBlur(variable.name)}
          disabled={isDisabled}
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
    return boilerplateConfig!.variables.map((variable: BoilerplateVariable) => {
      const isDisabled = sharedVarNames.has(variable.name)
      return (
        <VariableField
          key={variable.name}
          id={id}
          variable={variable}
          value={formData[variable.name]}
          error={visibleErrors[variable.name]}
          onChange={(value) => handleInputChange(variable.name, value)}
          onBlur={() => handleFieldBlur(variable.name)}
          disabled={isDisabled}
        />
      )
    })
  }

  // Determine container classes and whether to show submit button based on variant
  const containerClasses = variant === 'embedded' 
    ? 'runbook-block bg-transparent relative'
    : 'runbook-block p-6 border border-gray-200 rounded-lg shadow-sm bg-gray-100 mb-4 relative';
  
  const shouldShowSubmitButton = variant === 'embedded' ? false : showSubmitButton;

  // Check if form is currently valid (for FormStatus)
  const formIsValid = isFormValid(formData)

  return (
    <div className={containerClasses}>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-5">
          {hasSections ? renderWithSections() : renderWithoutSections()}
        </div>
        
        {shouldShowSubmitButton && (
          <div className="pt-4 border-t border-gray-200">
            {!hasGenerated ? (
              // Before first generation: show the Generate button
              <>
                <Button
                  type="submit"
                  variant="default"
                  disabled={isGenerating || isAutoRendering || unmetOutputDependencies.length > 0}
                >
                  {effectiveButtonText}
                </Button>
                {/* Show warning for unmet output dependencies below the button */}
                {unmetOutputDependencies.length > 0 && (
                  <div className="mt-3 -mb-3">
                    <UnmetOutputDependenciesWarning unmetOutputDependencies={unmetOutputDependencies} />
                  </div>
                )}
              </>
            ) : (
              // After first generation: show FormStatus instead of button
              <FormStatus
                isValid={formIsValid}
                isUpdating={isAutoRendering}
                isInlineMode={isInlineMode}
              />
            )}
          </div>
        )}
      </form>
    </div>
  )
}
