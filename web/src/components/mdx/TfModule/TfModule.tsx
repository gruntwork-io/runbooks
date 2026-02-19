import { useMemo, useCallback } from 'react'
import { BoilerplateInputsForm } from '../_shared/components/BoilerplateInputsForm'
import { DuplicateIdError } from '../_shared/components/DuplicateIdError'
import { ErrorDisplay } from '../_shared/components/ErrorDisplay'
import { LoadingDisplay } from '../_shared/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import { useApiParseTfModule } from '@/hooks/useApiParseTfModule'
import { useInputRegistration } from '../_shared/hooks/useInputRegistration'
import { buildHclInputsMap } from '../_shared/lib/formatHclValue'

/**
 * TfModule component - parses an OpenTofu module at runtime and collects user input.
 *
 * This component dynamically parses .tf files in a module directory, renders a form
 * for all variables, and publishes values to context (including a _module namespace)
 * so <TemplateInline> components can render any output format.
 *
 * The source prop accepts both local relative paths and remote URLs:
 * - Local: "../modules/my-vpc"
 * - GitHub shorthand: "github.com/org/modules//vpc?ref=v1.0"
 * - Git prefix: "git::https://github.com/org/repo.git//path?ref=v1.0"
 * - GitHub browser URL: "https://github.com/org/repo/tree/main/modules/vpc"
 *
 * @param props.id - Unique identifier for this component (required)
 * @param props.source - Module source: local path or remote URL (required)
 */
interface TfModuleProps {
  id: string
  source: string
}

function TfModule({ id, source }: TfModuleProps) {
  // Validate props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <TfModule> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    if (!source) {
      return {
        message: "The <TfModule> component requires a 'source' prop.",
        details: "Provide a local path (e.g., '../modules/vpc') or a remote URL (e.g., 'github.com/org/modules//vpc?ref=v1.0').",
      }
    }
    return null
  }, [id, source])

  // Load boilerplate config by parsing the OpenTofu module
  const {
    data: boilerplateConfig,
    isLoading,
    error: apiError,
  } = useApiParseTfModule(source, !validationError)

  // Build enriched form data with _module namespace
  const enrichFormData = useCallback(
    (formData: Record<string, unknown>) => ({
      ...formData,
      _module: {
        source,
        inputs: { ...formData },
        hcl_inputs: buildHclInputsMap(formData, boilerplateConfig),
      },
    }),
    [source, boilerplateConfig]
  )

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
    componentType: 'TfModule',
    boilerplateConfig,
    validationError,
    apiError,
    enrichFormData,
  })

  if (isDuplicate) {
    return <DuplicateIdError id={id} isNormalizedCollision={isNormalizedCollision} collidingId={collidingId} />
  }
  if (isLoading) {
    return <LoadingDisplay message="Parsing OpenTofu module..." />
  }
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }
  if (apiError) {
    return <ErrorDisplay error={apiError} />
  }

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
      isInlineMode={true}
    />
  )
}

TfModule.displayName = 'TfModule'

export default TfModule
