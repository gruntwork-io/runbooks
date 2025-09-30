import React, { useMemo, useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { NewBoilerplateInputsForm } from './NewBoilerplateInputsForm'
import { ErrorDisplay } from '../BoilerplateInputs/components/ErrorDisplay'
import { LoadingDisplay } from '../BoilerplateInputs/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'

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

  // Memoize prefilledVariables to prevent infinite re-renders
  const memoizedPrefilledVariables = useMemo(() => prefilledVariables, [prefilledVariables]);

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

  // TODO: Add render error handling when useBoilerplateRender is implemented
  // if (renderError) {
  //   return <ErrorDisplay error={renderError} />
  // }

  // Main render - form with success indicator overlay if needed
  return (
    <NewBoilerplateInputsForm
      id={id}
      boilerplateConfig={boilerplateConfig}
      initialData={initialData}
      onSubmit={onGenerate}
      // TODO: Add these when useBoilerplateRender is implemented
      // onAutoRender={handleAutoRender}
      // onSubmit={handleGenerate}
      // isGenerating={isGenerating}
      // isAutoRendering={isAutoRendering}
      // showSuccessIndicator={showSuccessIndicator}
      // enableAutoRender={formState.hasGenerated}
      // hasGeneratedSuccessfully={formState.hasGeneratedSuccessfully}
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