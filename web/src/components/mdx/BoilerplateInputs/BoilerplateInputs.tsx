import React, { useCallback, useMemo, useReducer, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { BoilerplateInputsForm } from '../BoilerplateInputs/BoilerplateInputsForm'
import { useBoilerplateVariables } from '../BoilerplateInputs/hooks/useBoilerplateVariables'
import { useBoilerplateRender } from '../BoilerplateInputs/hooks/useBoilerplateRender'
import { ErrorDisplay } from '../BoilerplateInputs/components/ErrorDisplay'
import { LoadingDisplay } from '../BoilerplateInputs/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import type { BoilerplateConfig } from '../BoilerplateInputs/BoilerplateInputs.types'

/**
 * Helper function to extract text content from React children
 * This handles the case where MDX parses inline content as JSX elements
 */
const extractTextFromChildren = (children: ReactNode): string => {
  if (typeof children === 'string') {
    return children
  }
  
  if (Array.isArray(children)) {
    return children.map(extractTextFromChildren).join('')
  }
  
  if (React.isValidElement(children)) {
    return extractTextFromChildren((children as React.ReactElement<{ children?: ReactNode }>).props.children)
  }
  
  return ''
}

/** Form state interface for managing component state */
interface FormState {
  hasGenerated: boolean
  hasGeneratedSuccessfully: boolean
  currentFormData: Record<string, unknown>
}

/** Form Actions are objects that describe what state changes should happen. 
 *  -type is the type of action to perform
 *  -payload is the data to be passed to the action
 * */ 
type FormAction = 
  | { type: 'SET_GENERATED'; payload: boolean }
  | { type: 'SET_GENERATED_SUCCESSFULLY'; payload: boolean }
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
    case 'SET_GENERATED_SUCCESSFULLY':
      return { ...state, hasGeneratedSuccessfully: action.payload }
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
      error: "Invalid <BoilerplateInputs> configuration.",
      errorDetails: "You cannot both specify a templatePath and inline boilerplate.yml content. Please provide only one."
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
interface BoilerplateInputsProps {
  id: string
  templatePath?: string
  variables?: Record<string, unknown>
  onGenerate?: (variables: Record<string, unknown>) => void
  children?: ReactNode // For inline boilerplate.yml content
}

export const BoilerplateInputs: React.FC<BoilerplateInputsProps> = ({
  id,
  templatePath, 
  variables: prefilledVariables = {},
  onGenerate,
  children
}) => {
  const [boilerplateConfig, setBoilerplateConfig] = useState<BoilerplateConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<AppError | null>(null);
  
  // Use reducer for streamlined state management
  const [formState, dispatch] = useReducer(formReducer, {
    hasGenerated: false,
    hasGeneratedSuccessfully: false,
    currentFormData: prefilledVariables
  })

  // Extract the contents of the children if they are provided
  const childrenText = children ? extractTextFromChildren(children) : ''
    
  // Get a JSON object of the boilerplate variables
  const useBoilerplateVariablesResult = useBoilerplateVariables(
    templatePath 
      ? { templatePath } 
      : childrenText 
        ? { boilerplateYamlContent: childrenText }
        : undefined
  )
  
  console.log("useBoilerplateVariablesResult", useBoilerplateVariablesResult)
  
  useEffect(() => {
    setBoilerplateConfig(useBoilerplateVariablesResult.config)
    setError(useBoilerplateVariablesResult.error)
    setIsLoading(useBoilerplateVariablesResult.loading)
  }, [useBoilerplateVariablesResult.config, useBoilerplateVariablesResult.error, useBoilerplateVariablesResult.loading]) 

  // Render the boilerplate template
  const { isGenerating, isAutoRendering, showSuccessIndicator, error: renderError, generate, autoRender, reset } = useBoilerplateRender()
  
  /** Memoized validation to avoid recalculating on every render */
  const validationError = useMemo(() => 
    validateProps({ id, templatePath, children }), 
    [id, templatePath, children]
  )

  /** Handle form submission when user clicks generate button */
  const handleGenerate = useCallback(async (variables: Record<string, unknown>) => {
    if (!templatePath && !childrenText) return
    
    // Mark that user has generated at least once (enables auto-rendering)
    dispatch({ type: 'SET_GENERATED', payload: true })
    
    // Update the current form data to preserve values after generation
    dispatch({ type: 'UPDATE_FORM_DATA', payload: variables })
    
    try {
      if (templatePath) {
        await generate(templatePath, variables)
      } else if (childrenText) {
        await generate(childrenText, variables)
      }
      // Mark successful generation
      dispatch({ type: 'SET_GENERATED_SUCCESSFULLY', payload: true })
      
      // Call the optional onGenerate callback if provided
      if (onGenerate) {
        onGenerate(variables)
      }
    } catch (error) {
      // Reset successful generation state on error
      dispatch({ type: 'SET_GENERATED_SUCCESSFULLY', payload: false })
      throw error
    }
  }, [templatePath, childrenText, generate, onGenerate])

  /** Handle re-rendering when form data changes 
   *  This way, any updates to the form data will trigger a re-render of the boilerplate template
   *  so the user sees real-time updates.
  */
  const handleAutoRender = useCallback((variables: Record<string, unknown>) => {
    if (!templatePath && !childrenText) return
    if (!formState.hasGenerated) return
    
    if (templatePath) {
      autoRender(templatePath, variables)
    } else if (childrenText) {
      autoRender(childrenText, variables)
    }
  }, [templatePath, childrenText, autoRender, formState.hasGenerated])

  /** Handle reset to clear success/error states */
  const handleReset = useCallback(() => {
    reset()
    dispatch({ type: 'SET_GENERATED_SUCCESSFULLY', payload: false })
  }, [reset])

  // console.log("gets here 1");

  // Early return for validation errors
  if (validationError) {
    return <ErrorDisplay {...validationError} />
  }

  // console.log("gets here 2");

  console.log("isLoading", isLoading)
  console.log("useBoilerplateVariablesResult.config", useBoilerplateVariablesResult.config)

  // Early return for loading states
  if (isLoading) {
    return <LoadingDisplay message="Loading boilerplate configuration..." />
  }

  console.log("gets here 3");

  // Early return for API errors
  console.log('error', error)
  if (error) {
    return <ErrorDisplay error={error.message} errorDetails={error.details} />
  }

  // Early return for render errors
  if (renderError) {
    return (
      <ErrorDisplay 
        error={renderError.message}
        errorDetails={renderError.details}
        onRetry={handleReset}
      />
    )
  }

  // Main render - form with success indicator overlay if needed
  return (
    <BoilerplateInputsForm
      id={id!}
      boilerplateConfig={boilerplateConfig}
      initialData={formState.currentFormData}
      onAutoRender={handleAutoRender}
      onSubmit={handleGenerate}
      isGenerating={isGenerating}
      isAutoRendering={isAutoRendering}
      showSuccessIndicator={showSuccessIndicator}
      enableAutoRender={formState.hasGenerated}
      hasGeneratedSuccessfully={formState.hasGeneratedSuccessfully}
    />
  )
}
