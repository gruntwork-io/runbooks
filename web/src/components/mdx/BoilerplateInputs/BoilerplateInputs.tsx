import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import { BoilerplateInputsForm } from './components/BoilerplateInputsForm'
import { ErrorDisplay } from './components/ErrorDisplay'
import { LoadingDisplay } from './components/LoadingDisplay'
import type { AppError } from '@/types/error'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'
import { useApiBoilerplateRender } from '@/hooks/useApiBoilerplateRender'
import { useFileTree } from '@/hooks/useFileTree'
import type { CodeFileData } from '@/components/artifacts/code/FileTree'
import { extractYamlFromChildren } from './lib/extractYamlFromChildren'

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

function BoilerplateInputs({
  id,
  templatePath, 
  prefilledVariables = {},
  onGenerate,
  children
}: BoilerplateInputsProps) {
  const [formState, setFormState] = useState<BoilerplateConfig | null>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [renderFormData, setRenderFormData] = useState<Record<string, unknown>>({});
  
  // Get the global file tree context
  const { setFileTree } = useFileTree();

  // Don't memoize prefilledVariables - just use it directly
  // Memoizing objects can cause issues with React's dependency tracking
  const memoizedPrefilledVariables = prefilledVariables;

  // Extract boolean to avoid React element in dependency array
  const hasChildren = !!children;

  // Validate props first - this is a component-level validation error
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <BoilerplateInputs> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }

    if (!templatePath && !hasChildren) {
      return {
        message: "Invalid <BoilerplateInputs> configuration.",
        details: "Please specify either a templatePath or inline boilerplate.yml content."
      }
    }

    if (templatePath && hasChildren) {
      return {
        message: "Invalid <BoilerplateInputs> configuration.",
        details: "You cannot both specify both a templatePath and inline boilerplate.yml content. Please provide only one."
      }
    }

    return null
  }, [id, templatePath, hasChildren])

  // Extract the contents of the children (inline boilerplate.yml content) if they are provided
  const inlineBoilerplateYamlContent = children ? extractYamlFromChildren(children) : ''
  
  // Validate inline content format - check if children structure indicates missing code fences
  // Note: We don't memoize this because children (React elements) can't be safely used in dependency arrays
  let inlineContentError: AppError | null = null
  if (children) {
    // Check if children contains React elements (indicating missing code fence)
    // When using a code fence, MDX provides a pre/code element structure
    // Without a code fence, MDX parses YAML as an array of paragraph/list elements
    const isArray = Array.isArray(children)
    const isReactElement = typeof children === 'object' && children !== null && 'type' in children && 
       (children.type === 'p' || children.type === 'ul' || children.type === 'li')
    
    if (isArray || isReactElement) {
      inlineContentError = {
        message: "Invalid inline boilerplate configuration format",
        details: "Please wrap your YAML content in a code fence (```yaml ... ```). Without code fences, MDX converts YAML into HTML elements, which cannot be parsed correctly."
      }
    }
  }
  
  // Only make API call if validation passes
  const { data: boilerplateConfig, isLoading, error: apiError } = useApiGetBoilerplateConfig(
    templatePath, 
    inlineBoilerplateYamlContent,
    !validationError && !inlineContentError // shouldFetch is false when there's any validation error
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
  const { data: renderResult, isLoading: isGenerating, error: renderError, isAutoRendering, autoRender } = useApiBoilerplateRender(
    templatePath || '',
    renderFormData,
    shouldRender && Boolean(templatePath)
  )

  // Update global file tree when render result is available
  useEffect(() => {
    if (renderResult && renderResult.fileTree) {
      // Cast the API response to match the expected type structure
      const fileTree = renderResult.fileTree as CodeFileData[];
      setFileTree(fileTree);
    }
  }, [renderResult, setFileTree]);

  // Handle auto-rendering when form data changes
  const handleAutoRender = useCallback((formData: Record<string, unknown>) => {
    if (!templatePath) return;
    if (!shouldRender) return; // Only auto-render after initial generation
    
    autoRender(templatePath, formData);
  }, [templatePath, shouldRender, autoRender]);

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

  // Early return for inline content format errors
  if (inlineContentError) {
    return <ErrorDisplay error={inlineContentError} />
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
    <BoilerplateInputsForm
      id={id}
      boilerplateConfig={boilerplateConfig}
      initialData={initialData}
      onAutoRender={handleAutoRender}
      onGenerate={handleGenerate}
      isGenerating={isGenerating}
      isAutoRendering={isAutoRendering}
      showSuccessIndicator={Boolean(renderResult)}
      enableAutoRender={true}
      hasGeneratedSuccessfully={Boolean(renderResult)}
    />
  )
}


export default BoilerplateInputs;