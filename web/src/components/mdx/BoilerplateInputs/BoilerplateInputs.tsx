import React, { useCallback } from 'react'
import type { BoilerplateInputsProps } from './BoilerplateInputs.types'
import { BoilerplateInputsForm } from './BoilerplateInputsForm'
import { useBoilerplateVariables } from './hooks/useBoilerplateVariables'
import { useBoilerplateRender } from './hooks/useBoilerplateRender'
import { ErrorDisplay } from './components/ErrorDisplay'
import { LoadingDisplay } from './components/LoadingDisplay'
import { SuccessDisplay } from './components/SuccessDisplay'

/**
 * BoilerplateInputs component for rendering dynamic forms based on boilerplate.yml configuration.
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
  // Use custom hooks for API logic
  const { config, loading, error, errorDetails } = useBoilerplateVariables(templatePath)
  const { isGenerating, success, error: renderError, errorDetails: renderErrorDetails, generate, reset } = useBoilerplateRender()

  // Handle form submission (when the user clicks the "generate" button and wants to render the boilerplate template)
  const handleGenerate = useCallback(async (variables: Record<string, unknown>) => {
    if (!templatePath) return
    
    await generate(templatePath, variables)
    
    // Call the optional onGenerate callback if provided
    if (onGenerate) {
      onGenerate(variables)
    }
  }, [templatePath, generate, onGenerate])

  // Handle reset (clear success/error states)
  const handleReset = useCallback(() => {
    reset()
  }, [reset])

  // Validate required props
  if (!id) {
    return (
      <ErrorDisplay 
        error="The BoilerplateInputs component requires a non-empty 'id' prop."
        errorDetails="Please provide a unique 'id' for this component instance."
      />
    )
  }

  if (!templatePath && !children) {
    return (
      <ErrorDisplay 
        error="No template path was provided."
        errorDetails="Please provide a templatePath to the boilerplate template directory."
      />
    )
  }

  if (children) {
    return (
      <ErrorDisplay 
        error="Inline boilerplate.yml parsing not yet implemented"
        errorDetails="Please provide a 'templatePath' to a boilerplate template directory instead of inline content."
      />
    )
  }

  // Show loading state
  if (loading) {
    return <LoadingDisplay message="Loading boilerplate configuration..." />
  }

  // Show error state
  if (error) {
    return (
      <ErrorDisplay 
        error={error}
        errorDetails={errorDetails}
      />
    )
  }

  // Show render error state
  if (renderError) {
    return (
      <ErrorDisplay 
        error={renderError}
        errorDetails={renderErrorDetails}
        onRetry={handleReset}
      />
    )
  }

  // Show success state
  if (success) {
    return (
      <SuccessDisplay 
        message={success}
        onReset={handleReset}
      />
    )
  }

  // Show form
  if (!config) {
    return <LoadingDisplay message="Loading boilerplate configuration..." />
  }

  return (
    <BoilerplateInputsForm
      id={id}
      boilerplateConfig={config}
      initialData={prefilledVariables}
      onSubmit={handleGenerate}
      isGenerating={isGenerating}
    />
  )
}
