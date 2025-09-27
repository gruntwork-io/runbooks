import React, { useCallback, useMemo, useReducer } from 'react'
import type { BoilerplateInputsProps } from '../BoilerplateInputs/BoilerplateInputs.types'
import { BoilerplateInputsForm } from '../BoilerplateInputs/BoilerplateInputsForm'
import { useBoilerplateVariables } from '../BoilerplateInputs/hooks/useBoilerplateVariables'
import { useBoilerplateRender } from '../BoilerplateInputs/hooks/useBoilerplateRender'
import { ErrorDisplay } from '../BoilerplateInputs/components/ErrorDisplay'
import { LoadingDisplay } from '../BoilerplateInputs/components/LoadingDisplay'

/** Form state interface for managing component state */
interface FormState {
  hasGenerated: boolean
  currentFormData: Record<string, unknown>
}

/** Form Actions are objects that describe what state changes should happen. 
 *  -type is the type of action to perform
 *  -payload is the data to be passed to the action
 * */ 
type FormAction = 
  | { type: 'SET_GENERATED'; payload: boolean }
  | { type: 'UPDATE_FORM_DATA'; payload: Record<string, unknown> }

/**
 * Form State Reducer for managing form state updates
 * @param state - Current form state
 * @param action - Action to perform on state
 * @returns Updated form state
 */
const formReducer = (state: FormState, action: FormAction): FormState => {
  switch (action.type) {
    case 'SET_GENERATED':
      return { ...state, hasGenerated: action.payload }
    case 'UPDATE_FORM_DATA':
      return { ...state, currentFormData: action.payload }
    default:
      return state
  }
}

/** Validation error interface */
interface ValidationError {
  error: string
  errorDetails: string
}

/**
 * Validates component props and returns error if invalid
 * @param props - Component props to validate
 * @returns Validation error or null if valid
 */
const validateProps = (props: Pick<BoilerplateInputsProps, 'id' | 'templatePath' | 'children'>): ValidationError | null => {
  if (!props.id) {
    return {
      error: "The BoilerplateInputs component requires a non-empty 'id' prop.",
      errorDetails: "Please provide a unique 'id' for this component instance."
    }
  }

  if (!props.templatePath && !props.children) {
    return {
      error: "No template path was provided.",
      errorDetails: "Please provide a templatePath to the boilerplate template directory."
    }
  }

  if (props.templatePath && props.children) {
    return {
      error: "You can specify both a templatePath and inline boilerplate.yml content. Please provide only one.",
      errorDetails: "Runbooks can either render a boilerplate template from your filesystem, or from what's defined inline. If you define both, it's not clear which one you want, so we throw an error."
    }
  }

  if (props.children) {
    return {
      error: "Inline boilerplate.yml parsing not yet implemented",
      errorDetails: "Please provide a 'templatePath' to a boilerplate template directory instead of inline content."
    }
  }

  return null
}

/**
 * BoilerplateInputs component for rendering a dynamic form based on boilerplate.yml configuration.
 * 
 * This component loads a boilerplate configuration (boilerplate.yml file) from a specified template path, renders a form
 * based on the variable definitions in the boilerplate.yml file, and allows users to generate
 * files by providing values for those variables. The component handles the entire workflow from
 * configuration loading to file generation via API calls.
 * 
 * @param props - The component props
 * @param props.id - Unique identifier for this component instance (required)
 * @param props.templatePath - Path to the boilerplate template directory, relative to the runbook file 
 * @param props.variables - Pre-filled variable values to populate the form with
 * @param props.onGenerate - Optional callback function called when files are successfully generated
 * @param props.children - Inline boilerplate.yml content (not yet implemented)
 * 
 * @example
 * ```tsx
 * <BoilerplateInputs
 *   id="terraform-setup"
 *   templatePath="terraform-boilerplate"
 *   variables={{ environment: "dev", region: "us-west-2" }}
 *   onGenerate={(vars) => console.log('Generated with:', vars)}
 * />
 * ```
 */
export const BoilerplateInputs: React.FC<BoilerplateInputsProps> = ({
  id,
  templatePath, 
  variables: prefilledVariables = {},
  onGenerate,
  children
}) => {
  // Use reducer for streamlined state management
  const [formState, dispatch] = useReducer(formReducer, {
    hasGenerated: false,
    currentFormData: prefilledVariables
  })
  
  // Use custom hooks for API logic
  const { config, loading, error, errorDetails } = useBoilerplateVariables(templatePath)
  const { isGenerating, isAutoRendering, showSuccessIndicator, error: renderError, errorDetails: renderErrorDetails, generate, autoRender, reset } = useBoilerplateRender()
  
  /** Memoized validation to avoid recalculating on every render */
  const validationError = useMemo(() => 
    validateProps({ id, templatePath, children }), 
    [id, templatePath, children]
  )

  /** Handle form submission when user clicks generate button */
  const handleGenerate = useCallback(async (variables: Record<string, unknown>) => {
    if (!templatePath) return
    
    // Mark that user has generated at least once (enables auto-rendering)
    dispatch({ type: 'SET_GENERATED', payload: true })
    
    // Update the current form data to preserve values after generation
    dispatch({ type: 'UPDATE_FORM_DATA', payload: variables })
    
    await generate(templatePath, variables)
    
    // Call the optional onGenerate callback if provided
    if (onGenerate) {
      onGenerate(variables)
    }
  }, [templatePath, generate, onGenerate])

  /** Handle re-rendering when form data changes 
   *  This way, any updates to the form data will trigger a re-render of the boilerplate template
   *  so the user sees real-time updates.
  */
  const handleAutoRender = useCallback((variables: Record<string, unknown>) => {
    if (!templatePath) return
    if (!formState.hasGenerated) return
    autoRender(templatePath, variables)
  }, [templatePath, autoRender, formState.hasGenerated])

  /** Handle reset to clear success/error states */
  const handleReset = useCallback(() => {
    reset()
  }, [reset])

  // Early return for validation errors
  if (validationError) {
    return <ErrorDisplay {...validationError} />
  }

  // Early return for loading states
  if (loading || !config) {
    return <LoadingDisplay message="Loading boilerplate configuration..." />
  }

  // Early return for API errors
  if (error) {
    return <ErrorDisplay error={error} errorDetails={errorDetails} />
  }

  // Early return for render errors
  if (renderError) {
    return (
      <ErrorDisplay 
        error={renderError}
        errorDetails={renderErrorDetails}
        onRetry={handleReset}
      />
    )
  }

  // Main render - form with success indicator overlay if needed
  return (
    <BoilerplateInputsForm
      id={id!}
      boilerplateConfig={config}
      initialData={formState.currentFormData}
      onAutoRender={handleAutoRender}
      onSubmit={handleGenerate}
      isGenerating={isGenerating}
      isAutoRendering={isAutoRendering}
      showSuccessIndicator={showSuccessIndicator}
      enableAutoRender={formState.hasGenerated}
    />
  )
}
