import { useMemo, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { BoilerplateInputsForm } from '../_shared/components/BoilerplateInputsForm'
import { DuplicateIdError } from '../_shared/components/DuplicateIdError'
import { ErrorDisplay } from '../_shared/components/ErrorDisplay'
import { LoadingDisplay } from '../_shared/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import { useApiGetBoilerplateConfig } from '@/hooks/useApiGetBoilerplateConfig'
import { extractYamlFromChildren } from '../_shared/lib/extractYamlFromChildren'
import { useInputRegistration } from '../_shared/hooks/useInputRegistration'

/**
 * Inputs component - collects user input via a web form.
 *
 * This component loads a boilerplate configuration and renders a web form
 * to collect variable values. It does NOT generate files - use <Template> for that.
 *
 * The collected variables are published to context so they can be used by:
 * - <Template> components (for file generation)
 * - <TemplateInline> components (for inline preview)
 * - <Command> and <Check> components (for script variable substitution)
 *
 * @param props.id - Unique identifier for this component (required)
 * @param props.path - Path to a boilerplate.yml file (relative to runbook)
 * @param props.children - Inline boilerplate.yml content as YAML code block
 *
 * (Use one of path or children, but not both)
 */
interface InputsProps {
  id: string
  path?: string
  prefilledVariables?: Record<string, unknown>
  children?: ReactNode // For inline boilerplate.yml content
  variant?: 'standard' | 'embedded' // 'embedded' means the Inputs are used inside Command or Check blocks
}

function Inputs({
  id,
  path,
  prefilledVariables = {},
  children,
  variant = 'standard'
}: InputsProps) {
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
    const hasPrefilledVars = Object.keys(prefilledVariables).length > 0
    if (!hasPrefilledVars) return boilerplateConfig
    return {
      ...boilerplateConfig,
      variables: boilerplateConfig.variables.map(variable => ({
        ...variable,
        default: prefilledVariables[variable.name] ? String(prefilledVariables[variable.name]) : variable.default
      }))
    }
  }, [boilerplateConfig, prefilledVariables])

  // Shared registration logic (ID registry, error reporting, telemetry, form state, debouncing)
  const {
    isDuplicate,
    isNormalizedCollision,
    collidingId,
    initialData,
    hasSubmitted,
    handleAutoUpdate,
    handleSubmit,
  } = useInputRegistration({
    id,
    componentType: 'Inputs',
    boilerplateConfig: boilerplateConfigWithPrefilledVariables,
    validationError,
    apiError,
    extraError: inlineContentError,
  })

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

  if (isDuplicate) {
    return <DuplicateIdError id={id} isNormalizedCollision={isNormalizedCollision} collidingId={collidingId} />
  }
  if (isLoading) {
    return <LoadingDisplay message="Loading configuration..." />
  }
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }
  if (inlineContentError) {
    return <ErrorDisplay error={inlineContentError} />
  }
  if (apiError) {
    return <ErrorDisplay error={apiError} />
  }

  return (
    <BoilerplateInputsForm
      id={id}
      boilerplateConfig={boilerplateConfigWithPrefilledVariables}
      initialData={initialData}
      onAutoRender={handleAutoUpdate}
      onGenerate={handleSubmit}
      isGenerating={false}
      isAutoRendering={false}
      enableAutoRender={true}
      hasGeneratedSuccessfully={hasSubmitted}
      variant={variant}
      isInlineMode={true}
    />
  )
}

Inputs.displayName = 'Inputs';

export default Inputs;
