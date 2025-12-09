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
import type { FileTreeNode } from '@/components/artifacts/code/FileTree'
import { extractYamlFromChildren } from './lib/extractYamlFromChildren'
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import { useBoilerplateRenderCoordinator } from '@/contexts/useBoilerplateRenderCoordinator'

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
  variant?: 'standard' | 'embedded'
}

function BoilerplateInputs({
  id,
  templatePath, 
  prefilledVariables = {},
  onGenerate,
  children,
  variant = 'standard'
}: BoilerplateInputsProps) {
  const [formState, setFormState] = useState<BoilerplateConfig | null>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [renderFormData, setRenderFormData] = useState<Record<string, unknown>>({});
  const [coordinatorRenderSuccess, setCoordinatorRenderSuccess] = useState(false);
  
  // Get the global file tree context
  const { setFileTree } = useFileTree();
  
  // Get the boilerplate variables context to share variables, config, and raw YAML with BoilerplateTemplate components
  const { setVariables, setConfig, setYamlContent } = useBoilerplateVariables();
  
  // Get the render coordinator for inline templates
  const { renderAllForInputsId } = useBoilerplateRenderCoordinator();

  // Extract boolean to avoid React element in dependency array
  const hasChildren = Boolean(children);

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
  const yamlExtraction = children ? extractYamlFromChildren(children) : { content: '', error: null }
  const inlineYamlContent = yamlExtraction.content
  const inlineContentError = yamlExtraction.error
  
  // Only make API call if validation passes
  const { data: boilerplateConfig, isLoading, error: apiError } = useApiGetBoilerplateConfig(
    templatePath, 
    inlineYamlContent,
    !validationError && !inlineContentError // shouldFetch is false when there's any validation error
  );

  // Apply the prefilled variables to the boilerplate config
  const boilerplateConfigWithPrefilledVariables = useMemo(() => {
    if (!boilerplateConfig) return null
    return {
      ...boilerplateConfig,
      variables: boilerplateConfig.variables.map(variable => ({ 
        ...variable, 
        default: prefilledVariables[variable.name] ? String(prefilledVariables[variable.name]) : variable.default 
      }))
    }
  }, [boilerplateConfig, prefilledVariables])
  
  // Update form state when boilerplate config changes - use a ref to track if we've already set it
  const hasSetFormState = useRef(false)
  useEffect(() => {
    if (boilerplateConfigWithPrefilledVariables && !hasSetFormState.current) {
      setFormState(boilerplateConfigWithPrefilledVariables)
      hasSetFormState.current = true
    }
  }, [boilerplateConfigWithPrefilledVariables])
  
  // Store the boilerplate config and raw YAML in context so BoilerplateTemplate can access it
  useEffect(() => {
    if (boilerplateConfig) {
      setConfig(id, boilerplateConfig)
      // Store the raw YAML content from the API response
      if (boilerplateConfig.rawYaml) {
        setYamlContent(id, boilerplateConfig.rawYaml)
      }
    }
  }, [boilerplateConfig, id, setConfig, setYamlContent])

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

  // Update global file tree when render result is available from file-based template
  // Replace the entire file tree since the backend clears the output folder before each render
  useEffect(() => {
    if (renderResult && renderResult.fileTree) {
      const fileTree = renderResult.fileTree as FileTreeNode[];
      setFileTree(fileTree);
    }
  }, [renderResult, setFileTree]);

  // Debounce timer ref for auto-render
  const autoRenderTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Handle auto-rendering when form data changes (debounced)
  const handleAutoRender = useCallback((formData: Record<string, unknown>) => {
    if (!shouldRender) return; // Only auto-render after initial generation
    
    // Type guard: id is validated to be non-empty by validationError check
    const inputsId: string = id ?? '';
    if (!inputsId) return;
    
    // Clear existing timer
    if (autoRenderTimerRef.current) {
      clearTimeout(autoRenderTimerRef.current);
    }
    
    // Debounce: wait 200ms after last change before updating
    autoRenderTimerRef.current = setTimeout(() => {
      // Update variables in context so BoilerplateTemplate components can re-render reactively
      // This triggers the auto-update effect in BoilerplateTemplate.tsx (lines 149-195)
      setVariables(inputsId, formData);
      
      // If templatePath exists, also trigger file-based template (vs. inline templates) auto-render
      if (templatePath) {
        autoRender(templatePath, formData);
      }
    }, 200);
  }, [id, templatePath, shouldRender, autoRender, setVariables]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoRenderTimerRef.current) {
        clearTimeout(autoRenderTimerRef.current);
      }
    };
  }, []);

  // Handle successful generation - trigger render API call
  const handleGenerate = useCallback(async (formData: Record<string, unknown>) => {
    // Type guard: id is validated to be non-empty by validationError check
    const inputsId: string = id ?? '';
    if (!inputsId) {
      console.error(`[BoilerplateInputs] No inputsId provided!`);
      return;
    }
    
    // Publish variables to context (needed for both inline templates and auto-updates)
    setVariables(inputsId, formData);
    
    // Always call coordinator (this is needed by inline templates if any are registered)
    try {
      await renderAllForInputsId(inputsId, formData);
      setCoordinatorRenderSuccess(true);
    } catch (error) {
      console.error(`[BoilerplateInputs][${inputsId}] Coordinator render failed:`, error);
      setCoordinatorRenderSuccess(false);
    }
    
    // Also render file-based templates if templatePath exists
    // Notably, a BoilerplateInputs component instance could be used to render both inline templates and file-based templates
    if (templatePath) {
      setRenderFormData(formData);
      setShouldRender(true);
    }
    
    // Mark as rendered for auto-updates (even if only coordinator was called)
    setShouldRender(true);

    // Call the original onGenerate callback if provided
    if (onGenerate) {
      onGenerate(formData);
    }
  }, [id, templatePath, setVariables, renderAllForInputsId, onGenerate])
  
  // For embedded variant, automatically trigger initial render when form is ready
  const hasTriggeredInitialRender = useRef(false);
  useEffect(() => {
    if (variant === 'embedded' && 
        boilerplateConfig && 
        !hasTriggeredInitialRender.current && 
        !shouldRender) {
      // Trigger the initial generation automatically
      hasTriggeredInitialRender.current = true;
      handleGenerate(initialData);
    }
  }, [variant, boilerplateConfig, shouldRender, initialData, handleGenerate]);

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
      showSuccessIndicator={Boolean(renderResult) || coordinatorRenderSuccess}
      enableAutoRender={true}
      hasGeneratedSuccessfully={Boolean(renderResult) || coordinatorRenderSuccess}
      variant={variant}
      isInlineMode={!templatePath && hasChildren}
    />
  )
}

// Set displayName for React DevTools and component detection in production builds
BoilerplateInputs.displayName = 'BoilerplateInputs';

export default BoilerplateInputs;