import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import { BoilerplateInputsForm } from '../BoilerplateInputs/components/BoilerplateInputsForm'
import { ErrorDisplay } from '../BoilerplateInputs/components/ErrorDisplay'
import { LoadingDisplay } from '../BoilerplateInputs/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'
import { extractYamlFromChildren } from '../BoilerplateInputs/lib/extractYamlFromChildren'
// TODO: Remove this legacy import when BoilerplateInputs is retired
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import { useBlockVariables } from '@/contexts/useBlockVariables'

/**
 * Inputs component - collects user input via a web form.
 * 
 * This component loads a boilerplate configuration and renders a web form
 * to collect variable values. It does NOT generate files - use <Template> for that.
 * 
 * The collected variables are published to context so they can be used by:
 * - <Template> components (for file generation)
 * - <TemplatePreview> components (for inline preview)
 * - <Command> and <Check> components (for script variable substitution)
 * 
 * @param props.id - Unique identifier for this component (required)
 * @param props.path - Path to a boilerplate.yml file (relative to runbook)
 * @param props.children - Inline boilerplate.yml content as YAML code block
 * 
 * (Use one of path or children, but not both)
 * 
 * @example
 * // With path to boilerplate.yml
 * <Inputs id="config" path="templates/vpc" />
 * 
 * @example
 * // With inline YAML
 * <Inputs id="config">
 * ```yaml
 * variables:
 *   - name: ProjectName
 *     type: string
 * ```
 * </Inputs>
 */
interface InputsProps {
  id: string
  path?: string
  prefilledVariables?: Record<string, unknown>
  onSubmit?: (variables: Record<string, unknown>) => void
  children?: ReactNode // For inline boilerplate.yml content
  variant?: 'standard' | 'embedded' // 'embedded' means the Inputs are used inside Command or Check blocks
}

function Inputs({
  id,
  path,
  prefilledVariables = {},
  onSubmit,
  children,
  variant = 'standard'
}: InputsProps) {
  const [formState, setFormState] = useState<BoilerplateConfig | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  
  // Get the block variables context (user-input variable values)
  const { registerInputs } = useBlockVariables();
  
  // TODO: Remove this legacy hook when BoilerplateInputs is retired
  // Legacy: Also publish to old context so BoilerplateInputs can still work
  const { setVariables, setConfig, setYamlContent } = useBoilerplateVariables();

  // Extract boolean to avoid React element in dependency array
  const hasChildren = Boolean(children);

  // Validate props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <Inputs> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }

    if (!path && !hasChildren) {
      return {
        message: "Invalid <Inputs> configuration.",
        details: "Please specify either a 'path' to a boilerplate.yml file or provide inline YAML content."
      }
    }

    if (path && hasChildren) {
      return {
        message: "Invalid <Inputs> configuration.",
        details: "You cannot specify both a 'path' and inline YAML content. Please provide only one."
      }
    }

    return null
  }, [id, path, hasChildren])

  // Extract inline YAML content from children if provided
  const yamlExtraction = children ? extractYamlFromChildren(children) : { content: '', error: null }
  const inlineYamlContent = yamlExtraction.content
  const inlineContentError = yamlExtraction.error
  
  // Load boilerplate config from path or inline YAML
  const { data: boilerplateConfig, isLoading, error: apiError } = useApiGetBoilerplateConfig(
    path, 
    inlineYamlContent,
    !validationError && !inlineContentError
  );

  // Apply prefilled variables to the boilerplate config
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
  
  // Update form state when boilerplate config changes
  const hasSetFormState = useRef(false)
  useEffect(() => {
    if (boilerplateConfigWithPrefilledVariables && !hasSetFormState.current) {
      setFormState(boilerplateConfigWithPrefilledVariables)
      hasSetFormState.current = true
    }
  }, [boilerplateConfigWithPrefilledVariables])
  
  // TODO: Remove this useEffect when BoilerplateTemplate adopts BlockVariablesContext
  // Store the boilerplate config in legacy context so BoilerplateTemplate components can access it
  useEffect(() => {
    if (boilerplateConfig) {
      setConfig(id, boilerplateConfig)
      if (boilerplateConfig.rawYaml) {
        setYamlContent(id, boilerplateConfig.rawYaml)
      }
    }
  }, [boilerplateConfig, id, setConfig, setYamlContent])
  // END legacy useEffect

  // Convert form state to initial data format
  const initialData = useMemo(() => {
    if (!formState) return {}
    return formState.variables.reduce((acc, variable) => {
      acc[variable.name] = variable.default
      return acc
    }, {} as Record<string, unknown>)
  }, [formState])

  // Debounce timer ref for auto-updates
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Handle auto-update when form data changes (after initial submit)
  const handleAutoUpdate = useCallback((formData: Record<string, unknown>) => {
    if (!hasSubmitted) return;
    
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current);
    }
    
    autoUpdateTimerRef.current = setTimeout(() => {
      // Update new BlockVariablesContext
      if (boilerplateConfig) {
        registerInputs(id, formData, boilerplateConfig);
      }
      // TODO: Remove this legacy call when BoilerplateTemplate adopts BlockVariablesContext
      setVariables(id, formData);
    }, 200);
  }, [id, hasSubmitted, boilerplateConfig, registerInputs, setVariables]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current);
      }
    };
  }, []);

  // Handle form submission
  const handleSubmit = useCallback(async (formData: Record<string, unknown>) => {
    // Publish to new BlockVariablesContext (values + config together)
    if (boilerplateConfig) {
      registerInputs(id, formData, boilerplateConfig);
    }
    
    // TODO: Remove this legacy call when BoilerplateInputs is retired
    setVariables(id, formData);
    
    setHasSubmitted(true);

    // Call the callback if provided
    if (onSubmit) {
      onSubmit(formData);
    }
  }, [id, boilerplateConfig, registerInputs, setVariables, onSubmit])
  
  // For embedded variant, automatically submit when form is ready
  const hasTriggeredInitialSubmit = useRef(false);
  useEffect(() => {
    if (variant === 'embedded' && 
        boilerplateConfig && 
        !hasTriggeredInitialSubmit.current && 
        !hasSubmitted) {
      hasTriggeredInitialSubmit.current = true;
      handleSubmit(initialData);
    }
  }, [variant, boilerplateConfig, hasSubmitted, initialData, handleSubmit]);

  // Early return for loading state
  if (isLoading) {
    return <LoadingDisplay message="Loading configuration..." />
  }
  
  // Early return for validation errors
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

  // Render the form
  return (
    <BoilerplateInputsForm
      id={id}
      boilerplateConfig={boilerplateConfig}
      initialData={initialData}
      onAutoRender={handleAutoUpdate}
      onGenerate={handleSubmit}
      isGenerating={false}
      isAutoRendering={false}
      enableAutoRender={true}
      hasGeneratedSuccessfully={hasSubmitted}
      variant={variant}
      isInlineMode={true} // Always use "Submit" button for Inputs
    />
  )
}

Inputs.displayName = 'Inputs';

export default Inputs;
