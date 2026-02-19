import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { XCircle } from 'lucide-react'
import { BoilerplateInputsForm } from '../_shared/components/BoilerplateInputsForm'
import { ErrorDisplay } from '../_shared/components/ErrorDisplay'
import { LoadingDisplay } from '../_shared/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'
import type { BoilerplateVariableType } from '@/types/boilerplateVariable'
import { useApiParseTfModule } from '@/hooks/useApiParseTfModule'
import { useRunbookContext } from '@/contexts/useRunbook'
import { useComponentIdRegistry } from '@/contexts/ComponentIdRegistry'
import { useErrorReporting } from '@/contexts/useErrorReporting'
import { useTelemetry } from '@/contexts/useTelemetry'
import { buildHclInputsMap } from '../_shared/lib/formatHclValue'

/**
 * TfModule component - parses an OpenTofu module at runtime and collects user input.
 *
 * This component dynamically parses .tf files in a module directory, renders a form
 * for all variables, and publishes values to context (including a _module namespace)
 * so <TemplateInline> components can render any output format.
 *
 * The _module namespace contains:
 * - source: the module source URL (from props)
 * - path: the module path (from props)
 * - inputs: raw form values for all variables
 * - hcl_inputs: pre-formatted HCL string values for template iteration
 *
 * @param props.id - Unique identifier for this component (required)
 * @param props.path - Path to the .tf module directory, relative to the runbook
 * @param props.source - Remote module source URL (optional, for use in templates)
 *
 * @example
 * <TfModule id="vpc-vars" path="../modules/my-vpc" source="github.com/org/modules//vpc?ref=v1.0" />
 */
interface TfModuleProps {
  id: string
  path: string
  source?: string
}

function TfModule({ id, path, source = '' }: TfModuleProps) {
  // Register with ID registry to detect duplicates
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'TfModule')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('TfModule')
  }, [trackBlockRender])

  const [formState, setFormState] = useState<BoilerplateConfig | null>(null)
  const [hasSubmitted, setHasSubmitted] = useState(false)

  // Get the runbook context to register input values
  const { registerInputs } = useRunbookContext()

  // Validate props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <TfModule> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    if (!path) {
      return {
        message: "The <TfModule> component requires a 'path' prop.",
        details: "Please specify the path to an OpenTofu module directory containing .tf files.",
      }
    }
    return null
  }, [id, path])

  // Load boilerplate config by parsing the OpenTofu module
  const {
    data: boilerplateConfig,
    isLoading,
    error: apiError,
  } = useApiParseTfModule(path, !validationError)

  // Report errors to the error reporting context
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'TfModule',
        severity: 'error',
        message: `Duplicate component ID: ${id}`,
      })
    } else if (validationError) {
      reportError({
        componentId: id,
        componentType: 'TfModule',
        severity: 'error',
        message: validationError.message,
      })
    } else if (apiError) {
      reportError({
        componentId: id,
        componentType: 'TfModule',
        severity: 'error',
        message: apiError.message,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, validationError, apiError, reportError, clearError])

  // Build a map of variable name → BoilerplateVariableType for HCL formatting
  const variableTypes = useMemo(() => {
    const types = new Map<string, BoilerplateVariableType>()
    if (boilerplateConfig) {
      for (const v of boilerplateConfig.variables) {
        types.set(v.name, v.type)
      }
    }
    return types
  }, [boilerplateConfig])

  // Update form state when boilerplate config changes
  const hasSetFormState = useRef(false)
  useEffect(() => {
    if (boilerplateConfig && !hasSetFormState.current) {
      setFormState(boilerplateConfig)
      hasSetFormState.current = true
    }
  }, [boilerplateConfig])

  // Convert form state to initial data format
  const initialData = useMemo(() => {
    if (!formState) return {}
    return formState.variables.reduce(
      (acc, variable) => {
        acc[variable.name] = variable.default
        return acc
      },
      {} as Record<string, unknown>
    )
  }, [formState])

  // Build enriched form data with _module namespace
  const buildEnrichedFormData = useCallback(
    (formData: Record<string, unknown>) => {
      return {
        ...formData,
        _module: {
          source,
          path,
          inputs: { ...formData },
          hcl_inputs: buildHclInputsMap(formData, variableTypes),
        },
      }
    },
    [source, path, variableTypes]
  )

  // Debounce timer ref for auto-updates
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Handle auto-update when form data changes (after initial submit)
  const handleAutoUpdate = useCallback(
    (formData: Record<string, unknown>) => {
      if (!hasSubmitted) return

      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current)
      }

      autoUpdateTimerRef.current = setTimeout(() => {
        if (boilerplateConfig) {
          registerInputs(id, buildEnrichedFormData(formData), boilerplateConfig)
        }
      }, 200)
    },
    [id, hasSubmitted, boilerplateConfig, registerInputs, buildEnrichedFormData]
  )

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current)
      }
    }
  }, [])

  // Handle form submission
  const handleSubmit = useCallback(
    async (formData: Record<string, unknown>) => {
      if (boilerplateConfig) {
        registerInputs(id, buildEnrichedFormData(formData), boilerplateConfig)
      }
      setHasSubmitted(true)
    },
    [id, boilerplateConfig, registerInputs, buildEnrichedFormData]
  )

  // Early return for duplicate ID error
  if (isDuplicate) {
    return (
      <div className="relative rounded-sm border bg-red-50 border-red-200 mb-5 p-4">
        <div className="flex items-center text-red-600">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong>
                <br />
                The ID{' '}
                <code className="bg-red-100 px-1 rounded">{`"${id}"`}</code>{' '}
                collides with{' '}
                <code className="bg-red-100 px-1 rounded">{`"${collidingId}"`}</code>{' '}
                because hyphens are converted to underscores for template
                access. Use different IDs to avoid this collision.
              </>
            ) : (
              <>
                <strong>Duplicate ID Error:</strong> Another component already
                uses id=&quot;{id}&quot;. Each component must have a unique id.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Early return for loading state
  if (isLoading) {
    return <LoadingDisplay message="Parsing OpenTofu module..." />
  }

  // Early return for validation errors
  if (validationError) {
    return <ErrorDisplay error={validationError} />
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
      isInlineMode={true}
    />
  )
}

TfModule.displayName = 'TfModule'

export default TfModule
