import { useMemo, useCallback } from 'react'
import { BoilerplateInputsForm } from '../_shared/components/BoilerplateInputsForm'
import { DuplicateIdError } from '../_shared/components/DuplicateIdError'
import { ErrorDisplay } from '../_shared/components/ErrorDisplay'
import { LoadingDisplay } from '../_shared/components/LoadingDisplay'
import type { AppError } from '@/types/error'
import { useApiParseTfModule } from '@/hooks/useApiParseTfModule'
import { useInputRegistration } from '../_shared/hooks/useInputRegistration'
import { buildHclInputsMap, buildNonEmptyHclInputsMap } from '../_shared/lib/formatHclValue'
import { useRunbookContext } from '@/contexts/useRunbook'

/**
 * Special keyword for the source prop that resolves to the remote URL
 * passed to the `runbooks open` CLI command. This enables generic runbooks
 * that work with any OpenTofu module URL.
 */
const SOURCE_KEYWORD = '::source'

/**
 * TfModule component - parses an OpenTofu module at runtime and collects user input.
 *
 * This component dynamically parses .tf files in a module directory, renders a form
 * for all variables, and publishes values to context (including a _module namespace)
 * so <TemplateInline> components can render any output format.
 *
 * The source prop accepts both local relative paths and remote URLs:
 * - Local: "../modules/my-vpc"
 * - Colocated: "." (same directory as the runbook)
 * - Dynamic: "::source" (resolved from the `runbooks open` CLI invocation)
 * - GitHub shorthand: "github.com/org/modules//vpc?ref=v1.0"
 * - Git prefix: "git::https://github.com/org/repo.git//path?ref=v1.0"
 * - GitHub browser URL: "https://github.com/org/repo/tree/main/modules/vpc"
 *
 * @param props.id - Unique identifier for this component (required)
 * @param props.source - Module source: local path, remote URL, ".", or "::source" (required)
 */
interface TfModuleProps {
  id: string
  source: string
}

function TfModule({ id, source }: TfModuleProps) {
  const { remoteSource } = useRunbookContext()

  // Resolve ::source keyword to the remote URL from the CLI invocation
  const resolvedSource = useMemo(() => {
    if (source === SOURCE_KEYWORD) {
      return remoteSource || null // null signals missing remote source
    }
    return source
  }, [source, remoteSource])

  // Track whether ::source keyword is missing a remote source
  const isMissingRemoteSource = source === SOURCE_KEYWORD && !resolvedSource

  // Validate props
  const validationError = useMemo((): AppError | null => {
    if (isMissingRemoteSource) return null // handled by dedicated UI below
    if (!id) {
      return {
        message: "The <TfModule> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    if (!resolvedSource) {
      return {
        message: "The <TfModule> component requires a 'source' prop.",
        details: "Provide a local path (e.g., '../modules/vpc') or a remote URL (e.g., 'github.com/org/modules//vpc?ref=v1.0').",
      }
    }
    return null
  }, [id, resolvedSource, isMissingRemoteSource])

  // Load boilerplate config by parsing the OpenTofu module
  const {
    data: boilerplateConfig,
    isLoading,
    error: apiError,
  } = useApiParseTfModule(resolvedSource ?? undefined, !validationError)

  // Build enriched form data with _module namespace
  const metadata = boilerplateConfig?.metadata
  const enrichFormData = useCallback(
    (formData: Record<string, unknown>) => ({
      ...formData,
      _module: {
        source: resolvedSource,
        inputs: { ...formData },
        hcl_inputs: buildHclInputsMap(formData, boilerplateConfig),
        hcl_inputs_non_empty: buildNonEmptyHclInputsMap(formData, boilerplateConfig),
        folder_name: metadata?.folder_name ?? '',
        readme_title: metadata?.readme_title ?? '',
        output_names: metadata?.output_names ?? [],
        resource_names: metadata?.resource_names ?? [],
      },
    }),
    [resolvedSource, boilerplateConfig, metadata]
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

  // Show friendly message when ::source is used but no remote source is available
  if (isMissingRemoteSource) {
    return (
      <div className="p-6 bg-amber-50 border border-amber-200 rounded-lg">
        <div className="text-amber-800 font-semibold mb-2">
          No remote module source available
        </div>
        <div className="text-amber-700 text-sm">
          <p className="mb-2">
            This runbook uses <code className="bg-amber-100 px-1 rounded">source="::source"</code>,
            which expects a remote OpenTofu/Terraform module URL from the <code className="bg-amber-100 px-1 rounded">runbooks open</code> command.
          </p>
          <p>
            To use this runbook, run it with a remote module URL:
          </p>
          <pre className="mt-2 bg-amber-100 p-2 rounded text-xs">
            runbooks open --tf-runbook . https://github.com/org/repo/tree/main/modules/my-module
          </pre>
        </div>
      </div>
    )
  }
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
