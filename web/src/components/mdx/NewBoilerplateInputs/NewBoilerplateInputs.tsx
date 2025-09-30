import React, { useMemo, useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { NewBoilerplateInputsForm } from './components/NewBoilerplateInputsForm'
import { ErrorDisplay } from '../BoilerplateInputs/components/ErrorDisplay'
import { LoadingDisplay } from '../BoilerplateInputs/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'
import { useApiBoilerplateRender } from '@/hooks/useApiBoilerplateRender'

/**
 * Renders a dynamic web form based on a boilerplate.yml configuration.
 * 
 * This component loads a boilerplate configuration (boilerplate.yml file) from a specified template path, 
 * renders a web form based on the variable definitions in the boilerplate.yml file, and allows users to generate
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
  prefilledVariables?: Record<string, unknown>
  onGenerate?: (variables: Record<string, unknown>) => void
  isLoading?: boolean
  error?: AppError | null
  children?: ReactNode // For inline boilerplate.yml content  
}

function NewBoilerplateInputs({
  id,
  templatePath, 
  prefilledVariables = {},
  onGenerate,
  children
}: BoilerplateInputsProps) {
  const [formState, setFormState] = useState<BoilerplateConfig | null>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [renderFormData, setRenderFormData] = useState<Record<string, unknown>>({});

  // Memoize prefilledVariables to prevent infinite re-renders
  const memoizedPrefilledVariables = useMemo(() => 
    prefilledVariables, 
  [prefilledVariables]);

  // Validate props first - this is a component-level validation error
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <BoilerplateInputs> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }

    if (!templatePath && !children) {
      return {
        message: "Invalid <BoilerplateInputs> configuration.",
        details: "Please specify either a templatePath or inline boilerplate.yml content."
      }
    }

    if (templatePath && children) {
      return {
        message: "Invalid <BoilerplateInputs> configuration.",
        details: "You cannot both specify both a templatePath and inline boilerplate.yml content. Please provide only one."
      }
    }

    return null
  }, [id, templatePath, children])

  // Extract the contents of the children (inline boilerplate.yml content) if they are provided
  const inlineBoilerplateYamlContent = children ? extractTextFromChildren(children) : ''
  
  // Only make API call if validation passes
  const { data: boilerplateConfig, isLoading, error: apiError } = useApiGetBoilerplateConfig(
    templatePath, 
    inlineBoilerplateYamlContent,
    !validationError // shouldFetch is false when there's a validation error
  )

  // Apply the prefilled variables to the boilerplate config
  const boilerplateConfigWithPrefilledVariables = useMemo(() => {
    if (!boilerplateConfig) return null
    return {
      ...boilerplateConfig,
      variables: boilerplateConfig.variables.map(variable => ({ 
        ...variable, 
        default: memoizedPrefilledVariables[variable.name] ? String(memoizedPrefilledVariables[variable.name]) : variable.default 
      }))
    }
  }, [boilerplateConfig, memoizedPrefilledVariables])
  
  // Update form state when boilerplate config changes - use a ref to track if we've already set it
  const hasSetFormState = useRef(false)
  useEffect(() => {
    if (boilerplateConfigWithPrefilledVariables && !hasSetFormState.current) {
      setFormState(boilerplateConfigWithPrefilledVariables)
      hasSetFormState.current = true
    }
  }, [boilerplateConfigWithPrefilledVariables])

  // Convert form state to initial data format
  const initialData = useMemo(() => {
    if (!formState) return {}
    return formState.variables.reduce((acc, variable) => {
      acc[variable.name] = variable.default
      return acc
    }, {} as Record<string, unknown>)
  }, [formState])

  // Render API call - only triggered when shouldRender is true
  const { data: renderResult, isLoading: isGenerating, error: renderError } = useApiBoilerplateRender(
    templatePath || '',
    renderFormData,
    shouldRender && Boolean(templatePath)
  )

  // Handle form data changes (no longer needed for auto-rendering, but keeping for potential future use)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleFormChange = (_formData: Record<string, unknown>) => {
    // Form data changes are handled by the form component itself
    // This callback is kept for potential future use
  }

  // Handle successful generation - trigger render API call
  const handleGenerate = (formData: Record<string, unknown>) => {
    // Set the form data to render and trigger the API call
    setRenderFormData(formData)
    setShouldRender(true)

    // Call the original onGenerate callback if provided
    if (onGenerate) {
      onGenerate(formData)
    }
  }

  // Early return for loading states
  if (isLoading) {
    return <LoadingDisplay message="Loading boilerplate configuration..." />
  }
  
  // Early return for validation errors (highest priority)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for API errors
  if (apiError) {
    return <ErrorDisplay error={apiError} />
  }

  // Early return for render errors
  if (renderError) {
    return <ErrorDisplay error={renderError} />
  }

  // Main render - form with success indicator overlay if needed
  return (
    <NewBoilerplateInputsForm
      id={id}
      boilerplateConfig={boilerplateConfig}
      initialData={initialData}
      onFormChange={handleFormChange}
      onGenerate={handleGenerate}
      isGenerating={isGenerating}
      showSuccessIndicator={Boolean(renderResult)}
      enableAutoRender={false}
      hasGeneratedSuccessfully={Boolean(renderResult)}
    />
  )
}

/**
 * Helper function to extract text content from React children
 * This handles the case where MDX parses inline content as JSX elements
 */
function extractTextFromChildren(children: ReactNode): string {
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

export default NewBoilerplateInputs;