import React, { useCallback, useState } from 'react'
import type { BoilerplateInputsProps } from './BoilerplateInputs.types'
import { BoilerplateInputsForm } from './BoilerplateInputsForm'
import { useBoilerplateVariables } from './hooks/useBoilerplateVariables'
import { useBoilerplateRender } from './hooks/useBoilerplateRender'
import { ErrorDisplay } from './components/ErrorDisplay'
import { LoadingDisplay } from './components/LoadingDisplay'
import { SuccessIndicator } from './components/SuccessIndicator'

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
  // Track the current form values to preserve them after generation
  const [currentFormData, setCurrentFormData] = useState<Record<string, unknown>>(prefilledVariables)
  
  // Use custom hooks for API logic
  const { config, loading, error, errorDetails } = useBoilerplateVariables(templatePath)
  const { isGenerating, success, showSuccessIndicator, error: renderError, errorDetails: renderErrorDetails, generate, reset } = useBoilerplateRender()

  // Handle form submission (when the user clicks the "generate" button and wants to render the boilerplate template)
  const handleGenerate = useCallback(async (variables: Record<string, unknown>) => {
    if (!templatePath) return
    
    // Update the current form data to preserve values after generation
    setCurrentFormData(variables)
    
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

  // Show form (always show form, with success indicator overlay if needed)
  if (!config) {
    return <LoadingDisplay message="Loading boilerplate configuration..." />
  }

  return (
    <>
      <BoilerplateInputsForm
        id={id}
        boilerplateConfig={config}
        initialData={currentFormData}
        onSubmit={handleGenerate}
        isGenerating={isGenerating}
      />
      <SuccessIndicator 
        message={success || 'Files generated successfully!'}
        show={showSuccessIndicator}
      />
    </>
  )
}
