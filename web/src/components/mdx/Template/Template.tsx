import { useMemo, useState, useEffect, useCallback, startTransition } from "react"
import { BoilerplateInputsForm } from "../_shared/components/BoilerplateInputsForm"
import { ErrorDisplay } from "../_shared/components/ErrorDisplay"
import { LoadingDisplay } from "../_shared/components/LoadingDisplay"
import type { AppError } from "@/types/error"
import { useApiGetBoilerplateConfig } from "@/hooks/useApiGetBoilerplateConfig"
import { useApiBoilerplateRender } from "@/hooks/useApiBoilerplateRender"
import { useRunbookContext, useInputs, useAllOutputs, flattenInputs } from "@/contexts/useRunbook"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTelemetry } from "@/contexts/useTelemetry"
import {
  buildRenderVariables,
  computeUnmetOutputDependencies,
  flattenBlockOutputs,
  revealTemplateOutputs,
} from "@/lib/templateUtils"
import { computeChangeKey } from "@/lib/changeDetection"
import { markStage } from "@/lib/renderPerf"
import { normalizeBlockId } from "@/lib/utils"
import { XCircle } from "lucide-react"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { TemplateInstruction } from "./TemplateInstruction"
import { useSharedTemplateVars } from "./useSharedTemplateVars"

/**
 * Template component - generates files from a boilerplate template directory.
 *
 * This component loads a boilerplate configuration, renders a form for any
 * variables defined in the template, and generates files to the workspace.
 * Files are written only when the user clicks Generate. A later change to
 * anything the template reads marks the files stale until the user regenerates.
 *
 * ## Variable Categories
 *
 * When a Template references external inputs via `inputsId`, variables fall into three categories:
 *
 * 1. **Local-only Variables** - exist only in the template's boilerplate.yml.
 *    These are editable in the form.
 *
 * 2. **Imported-only Variables** - exist only in imported sources (not in template's boilerplate.yml).
 *    These are not shown in the form but are passed through to the template engine.
 *
 * 3. **Shared Variables** - exist in BOTH the template's boilerplate.yml AND imported sources.
 *    These are read-only in the form and stay live-synced to imported values.
 *
 * @param props.id - Unique identifier for this component (required)
 * @param props.path - Path to the boilerplate template directory (required)
 * @param props.inputsId - Optional ID(s) of Inputs components to import variable values from
 *
 * @example
 * // Standalone template with its own form
 * <Template id="vpc-setup" path="templates/vpc" />
 *
 * @example
 * // Template importing variables from an Inputs block
 * <Inputs id="config">...</Inputs>
 * <Template id="vpc-setup" path="templates/vpc" inputsId="config" />
 */
interface TemplateProps {
  id: string
  path: string
  /** Reference to one or more Inputs by ID. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Where template output is written. "generated" (default) writes to $GENERATED_FILES. "worktree" writes to the active git worktree ($REPO_FILES). */
  target?: "generated" | "worktree"
}

function TemplateInteractive({ id, path, inputsId, target }: TemplateProps) {
  // Register with ID registry to detect duplicates (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, "Template")

  const { reportError, clearError } = useErrorReporting()

  const { trackBlockRender } = useTelemetry()

  // Track block render on mount
  useEffect(() => {
    trackBlockRender("Template")
  }, [trackBlockRender])

  const [localVarValues, setLocalVarValues] = useState<Record<string, unknown>>({})
  // Change key of the values the latest Generate click asked to render.
  const [requestedKey, setRequestedKey] = useState<string | null>(null)
  // Change key of the values the files on disk were rendered from. Null until
  // a render succeeds. A failed render writes no files, so it leaves this alone.
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)

  // (Worktree/file tree updates are handled by useApiBoilerplateRender via useFileTreeUpdater)

  // Get the runbook context to register our config
  const { registerInputs } = useRunbookContext()

  // Get inputs from referenced Inputs components (if any) and convert to values map
  const inputs = useInputs(inputsId)
  const inputValues = useMemo(() => flattenInputs(inputs), [inputs])

  // Get all block outputs to check dependencies and pass to template rendering
  const allOutputs = useAllOutputs()

  // Validate props
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <Template> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }

    if (!path) {
      return {
        message: "The <Template> component requires a 'path' prop.",
        details: "Please specify the path to the boilerplate template directory.",
      }
    }

    return null
  }, [id, path])

  // Load boilerplate config from the template path
  const {
    data: boilerplateConfig,
    isLoading,
    error: apiError,
  } = useApiGetBoilerplateConfig(
    path,
    "", // No inline YAML for Template
    !validationError,
  )

  // Report errors to the error reporting context
  useEffect(() => {
    // Determine if there's an error to report
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "Template",
        severity: "error",
        message: `Duplicate component ID: ${id}`,
      })
    } else if (validationError) {
      reportError({
        componentId: id,
        componentType: "Template",
        severity: "error",
        message: validationError.message,
      })
    } else if (apiError) {
      reportError({
        componentId: id,
        componentType: "Template",
        severity: "error",
        message: apiError.message,
      })
    } else {
      // No error, clear any previously reported error
      clearError(id)
    }
  }, [id, isDuplicate, validationError, apiError, reportError, clearError])

  // Shared variables (in BOTH imported sources AND this template's boilerplate.yml),
  // their live imported values, and the form's initial data.
  // This must be before early returns to maintain hook order
  const { sharedVarNames, liveVarValues, initialData } = useSharedTemplateVars(
    boilerplateConfig,
    inputValues,
  )

  // Compute unmet output dependencies - outputs from other blocks that this template needs
  // but which haven't been produced yet
  const unmetOutputDependencies = useMemo(
    () => computeUnmetOutputDependencies(boilerplateConfig?.outputDependencies ?? [], allOutputs),
    [boilerplateConfig?.outputDependencies, allOutputs],
  )

  // Publish this template's variables to the runbook context as they change,
  // whether or not the files have been regenerated.
  useEffect(() => {
    if (!boilerplateConfig || !id) return
    // Shared vars are read-only and live-synced, so the imported (live) value
    // overrides the local copy, which may not be synced yet when this effect runs.
    const mergedData = { ...inputValues, ...localVarValues, ...liveVarValues }
    // A transition, so re-rendering RunbookContext consumers doesn't hold up typing in the form.
    startTransition(() => registerInputs(id, mergedData, boilerplateConfig))
  }, [id, boilerplateConfig, inputValues, localVarValues, liveVarValues, registerInputs])

  // Pass the component id as templateId to enable smart file cleanup when outputs change
  const {
    data: renderResult,
    isLoading: isGenerating,
    error: renderError,
    render,
  } = useApiBoilerplateRender(path, id, target)

  // useIpc commits only the latest request's result, so a new result is the
  // render of requestedKey.
  const [committedResult, setCommittedResult] = useState(renderResult)
  if (renderResult !== committedResult) {
    setCommittedResult(renderResult)
    setGeneratedKey(requestedKey)
  }

  // Track successful generation (file tree updates are handled by useApiBoilerplateRender).
  // Marks render-committed and painted stages; the gap between IPC response and this
  // effect firing captures React scheduler + reconciliation + commit + passive-effect flush.
  useEffect(() => {
    if (!renderResult) return
    markStage("Template:render-committed", { id })
    const raf = requestAnimationFrame(() => markStage("Template:painted", { id }))
    return () => cancelAnimationFrame(raf)
  }, [renderResult, id])

  // Flatten block outputs for template rendering (used in the outputs namespace).
  // A Template writes files, so sensitive outputs render with their real
  // values. That also keeps them in the change key below, so a new value
  // marks the files stale.
  const flattenedOutputs = useMemo(
    () => revealTemplateOutputs(flattenBlockOutputs(allOutputs)),
    [allOutputs],
  )

  // Values of the outputs this template reads. The change key leaves every
  // other output out, so a block the template doesn't read can't mark its
  // files stale.
  const outputDependencyValues = useMemo(
    () =>
      (boilerplateConfig?.outputDependencies ?? []).map(
        (dep) => flattenedOutputs[normalizeBlockId(dep.blockId)]?.[dep.outputName],
      ),
    [boilerplateConfig?.outputDependencies, flattenedOutputs],
  )

  // Key over everything a render of this template reads, given the form's
  // values. liveVarValues overlays them because the form's copy of a shared var
  // lags the imported value by a render.
  const changeKeyFor = useCallback(
    (formValues: Record<string, unknown>) =>
      computeChangeKey(inputValues, { ...formValues, ...liveVarValues }, outputDependencyValues),
    [inputValues, liveVarValues, outputDependencyValues],
  )

  const isStale = useMemo(
    () => generatedKey !== null && changeKeyFor(localVarValues) !== generatedKey,
    [generatedKey, changeKeyFor, localVarValues],
  )

  // An error from rendering other values says nothing about files that match
  // the form again, so it is hidden until the form drifts from them.
  const showRenderError =
    renderError !== null && (generatedKey === null || isStale || requestedKey === generatedKey)

  // The only place a render starts, so the files change only on a click.
  const handleGenerate = useCallback(
    (formValues: Record<string, unknown>) => {
      setRequestedKey(changeKeyFor(formValues))
      render(
        buildRenderVariables({ ...inputValues, ...formValues, ...liveVarValues }, flattenedOutputs),
      )
    },
    [changeKeyFor, render, inputValues, liveVarValues, flattenedOutputs],
  )

  // Early return for duplicate ID error
  if (isDuplicate) {
    return (
      <div className="relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4">
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            {isNormalizedCollision ? (
              <>
                <strong>ID Collision:</strong>
                <br />
                The ID <code className="bg-destructive-muted px-1 rounded">{`"${id}"`}</code>{" "}
                collides with{" "}
                <code className="bg-destructive-muted px-1 rounded">{`"${collidingId}"`}</code>{" "}
                because hyphens are converted to underscores for template access. Use different IDs
                to avoid this collision.
              </>
            ) : (
              <>
                <strong>Duplicate ID Error:</strong> Another Template component already uses id="
                {id}". Each Template must have a unique id.
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Early return for loading state
  if (isLoading) {
    return <LoadingDisplay message="Loading template configuration..." />
  }

  // Early return for validation errors
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for API errors (config loading errors)
  if (apiError) {
    return <ErrorDisplay error={apiError} />
  }

  // Render the form with output dependency warning and inline render errors
  return (
    <div data-testid={id}>
      {/* Show render errors inline (don't unmount the form) */}
      {showRenderError && <ErrorDisplay error={renderError} />}

      <BoilerplateInputsForm
        id={id}
        blockType="Template"
        boilerplateConfig={boilerplateConfig}
        initialData={initialData}
        onFormChange={setLocalVarValues}
        onGenerate={handleGenerate}
        isGenerating={isGenerating}
        enableAutoRender={false}
        hasGeneratedSuccessfully={generatedKey !== null}
        hasRenderError={showRenderError}
        isStale={isStale}
        variant="standard"
        isInlineMode={false}
        sharedVarNames={sharedVarNames}
        liveVarValues={liveVarValues}
        unmetOutputDependencies={unmetOutputDependencies}
        importedValues={inputValues}
      />
    </div>
  )
}

/**
 * Template entry point. Branches on instruction mode before any render hooks
 * run: in instruction mode it renders the variable form plus a copy-pasteable
 * `boilerplate` invocation (no files written); otherwise the interactive
 * generate UI. Branching here keeps the render-to-disk path out of the
 * instruction component entirely.
 */
function Template(props: TemplateProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) {
    return <TemplateInstruction {...props} />
  }
  return <TemplateInteractive {...props} />
}

Template.displayName = "Template"

export default Template
