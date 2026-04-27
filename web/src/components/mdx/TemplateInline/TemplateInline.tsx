import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/_shared/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/_shared/components/ErrorDisplay'
import { UnmetDependenciesWarning } from '@/components/mdx/_shared/components/UnmetDependenciesWarning'
import { useInputs, useAllOutputs, flattenInputs, useGruntbookContext } from '@/contexts/useGruntbook'
import { extractTemplateDependencies, extractTemplateDependenciesFromString, splitDependencies } from '@/lib/extractTemplateDependencies'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import type { File, FileTreeNode } from '@/components/artifacts/code/FileTree'
import { createAppError, type AppError } from '@/types/error'
import { useApi } from '@/hooks/useApi'
import { useFileTreeUpdater } from '../_shared/hooks/useFileTreeUpdater'
import { computeChangeKey } from '@/lib/changeDetection'
import { CodeFile } from '@/components/artifacts/code/CodeFile'
import { AlertTriangle } from 'lucide-react'
import { DuplicateIdError } from '../_shared/components/DuplicateIdError'
import { useComponentIdRegistry } from '@/contexts/ComponentIdRegistry'
import { useErrorReporting } from '@/contexts/useErrorReporting'
import { useTelemetry } from '@/contexts/useTelemetry'
import { buildTemplatePayload, computeUnmetInputDependencies, computeUnmetOutputDependencies, flattenBlockOutputs, hasEmptyNumericInputs, resolveTemplateReferences } from '@/lib/templateUtils'
import { isDesktop } from '@/lib/wails'
import * as BoilerplateService from '@/bindings/github.com/gruntwork-io/runbooks/services/boilerplateservice'
import { RenderInlineRequest } from '@/bindings/github.com/gruntwork-io/runbooks/api/models'

interface RenderInlineResult {
  renderedFiles: Record<string, File>
  fileTree: FileTreeNode[]
  truncatedTree?: boolean
  totalFiles?: number
  heavyDirs?: Array<{ path: string; fileCount: number }>
}

interface TemplateInlineProps {
  /** Unique identifier for this block */
  id: string
  /** ID or array of IDs of Inputs components to get variable values from. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Output path prefix for generated files */
  outputPath?: string
  /** Whether to generate the file to the file tree (default: false, preview only) */
  generateFile?: boolean
  /** Where template output is written. "generated" (default) writes to $GENERATED_FILES. "worktree" writes to the active git worktree ($REPO_FILES). Only used when generateFile is true. */
  target?: 'generated' | 'worktree'
  /** Inline template content (code blocks with file paths) */
  children?: ReactNode
}

/**
 * TemplateInline renders inline template content with variable substitution.
 * It displays the rendered output as code blocks (preview only, no file generation).
 *
 * Variables are sourced from Inputs components referenced by inputsId.
 * When multiple inputsIds are provided, variables and configs are merged (later IDs override earlier).
 */
function TemplateInline({
  id,
  inputsId,
  outputPath,
  generateFile = false,
  target,
  children
}: TemplateInlineProps) {
  // Validate required props before any hooks that depend on id
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <TemplateInline> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance."
      }
    }
    return null
  }, [id])

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(id, 'TemplateInline')

  // Error reporting context
  const { reportError, clearError } = useErrorReporting()

  // Telemetry context
  const { trackBlockRender } = useTelemetry()

  // Track block render on mount
  useEffect(() => {
    trackBlockRender('TemplateInline')
  }, [trackBlockRender])

  // Render state — tracks whether we've ever rendered (for the "waiting" UI)
  const [hasRendered, setHasRendered] = useState(false);

  // Report configuration errors (duplicate ID / normalized collision) to the shared error context.
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: 'TemplateInline',
        severity: 'error',
        message: isNormalizedCollision
          ? `TemplateInline ID "${id}" collides with "${collidingId}" after normalization`
          : `Duplicate component ID: ${id}`
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError])

  // Track last rendered change key to avoid duplicate renders
  const lastRenderedKeyRef = useRef<string | null>(null);

  // Browser-mode HTTP path. The endpoint is empty in desktop mode so
  // useApi is inert; the IPC branch below drives rendering instead.
  // Lazy mode skips auto-fetch on mount; we use debouncedRequest explicitly.
  const httpResult = useApi<RenderInlineResult>(
    isDesktop() ? '' : '/api/boilerplate/render-inline', 'POST', undefined, 300, undefined, true
  );

  // Desktop-mode IPC path. Mirrors the dual-path pattern in
  // useApiBoilerplateRender: a debounced invoker drives BoilerplateService.RenderInline,
  // and a monotonic seq guard discards stale responses so a slow earlier
  // call can't clobber a faster later one when inputs change rapidly.
  const [ipcData, setIpcData] = useState<RenderInlineResult | null>(null)
  const [ipcLoading, setIpcLoading] = useState(false)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const ipcSeqRef = useRef(0)
  const ipcDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (ipcDebounceTimerRef.current) clearTimeout(ipcDebounceTimerRef.current)
    }
  }, [])

  const ipcDebouncedRequest = useCallback(
    (body: { templateFiles: Record<string, string>; inputs: unknown; generateFile?: boolean; target?: string }) => {
      if (ipcDebounceTimerRef.current) clearTimeout(ipcDebounceTimerRef.current)
      ipcDebounceTimerRef.current = setTimeout(() => {
        const seq = ++ipcSeqRef.current
        setIpcLoading(true)
        setIpcError(null)
        ;(async () => {
          try {
            const req = RenderInlineRequest.createFrom({
              templateFiles: body.templateFiles,
              inputs: body.inputs as Parameters<typeof RenderInlineRequest.createFrom>[0]['inputs'],
              ...(body.generateFile !== undefined ? { generateFile: body.generateFile } : {}),
              ...(body.target ? { target: body.target } : {}),
            })
            const res = await BoilerplateService.RenderInline(req)
            if (seq !== ipcSeqRef.current) return
            if (!res) {
              setIpcError('RenderInline returned null')
              return
            }
            setIpcData(res as unknown as RenderInlineResult)
          } catch (err) {
            if (seq !== ipcSeqRef.current) return
            setIpcError(err instanceof Error ? err.message : String(err))
          } finally {
            if (seq === ipcSeqRef.current) setIpcLoading(false)
          }
        })()
      }, 300)
    },
    [],
  )

  const data = isDesktop() ? ipcData : httpResult.data
  const isLoading = isDesktop() ? ipcLoading : httpResult.isLoading
  const error: AppError | null = isDesktop()
    ? (ipcError ? createAppError(ipcError) : null)
    : httpResult.error
  const debouncedRequest = isDesktop() ? ipcDebouncedRequest : httpResult.debouncedRequest;

  // File tree updater — handles Generated tab vs worktree updates
  const { applyFileTreeUpdate } = useFileTreeUpdater(target);

  // Get inputs for API requests and derive values map for lookups
  const inputs = useInputs(inputsId);
  const inputValues = useMemo(() => flattenInputs(inputs), [inputs]);

  // Track which inputsId blocks haven't registered values yet (for the waiting message)
  const { blockInputs } = useGruntbookContext();
  const unmetInputsIds = useMemo(() => {
    if (!inputsId) return [];
    const ids = Array.isArray(inputsId) ? inputsId : [inputsId];
    return ids.filter(id => !blockInputs[id]);
  }, [inputsId, blockInputs]);

  // Get all block outputs to check dependencies and pass to template rendering
  const allOutputs = useAllOutputs();

  // Extract all template dependencies from children and outputPath
  const allDeps = useMemo(() => [
    ...extractTemplateDependencies(children),
    ...extractTemplateDependenciesFromString(outputPath ?? ''),
  ], [children, outputPath]);
  const { inputs: inputDeps, outputs: outputDeps } = useMemo(() => splitDependencies(allDeps), [allDeps]);

  // Compute flattened outputs for template context
  const flattenedOutputs = useMemo(() => flattenBlockOutputs(allOutputs), [allOutputs]);

  // Resolve {{ .outputs.X.Y }} expressions in outputPath using block outputs.
  // This enables dynamic file paths like "{{ .outputs.target_path.PATH }}/terragrunt.hcl".
  const resolvedOutputPath = useMemo(
    () => outputPath ? resolveTemplateReferences(outputPath, { inputs: inputValues, outputs: flattenedOutputs }) : outputPath,
    [outputPath, inputValues, flattenedOutputs]
  );

  // Check which input/output dependencies are not yet satisfied
  const unmetInputDeps = useMemo(
    () => computeUnmetInputDependencies(inputDeps, inputValues),
    [inputDeps, inputValues]
  );
  const unmetOutputDeps = useMemo(
    () => computeUnmetOutputDependencies(outputDeps, allOutputs),
    [outputDeps, allOutputs]
  );
  const hasAllInputDeps = unmetInputDeps.length === 0;
  const hasAllOutputDeps = unmetOutputDeps.length === 0;

  // Extract template content from children
  // MDX compiles code blocks into a nested React element structure (pre > code > text),
  // so we need to traverse it to extract the actual content. Returns a Record because
  // the Boilerplate API expects a files map (filename → content), even for a single file.
  // Uses resolvedOutputPath so dynamic expressions are resolved before file naming.
  const templateFiles = useMemo(() => {
    return extractTemplateFiles(children, resolvedOutputPath);
  }, [children, resolvedOutputPath]);

  // Auto-render when inputs or outputs change
  useEffect(() => {
    if (isDuplicate) return;
    if (!hasAllInputDeps || !hasAllOutputDeps) return;
    // Don't render when inputsId blocks haven't submitted values yet.
    // Templates may reference root-level keys (e.g., ._module) injected by
    // upstream blocks like TfModule that aren't tracked as .inputs.X deps.
    if (unmetInputsIds.length > 0) return;

    // Skip render when a numeric input is empty (user is mid-edit, e.g., clearing
    // a number field before typing a new value). Sending "" to the backend would
    // cause type-conversion errors like strconv.Atoi("").
    if (hasEmptyNumericInputs(inputs)) return;

    // Deduplicate renders: hash the current inputs/outputs and skip if nothing changed.
    // This prevents redundant API calls when React re-runs the effect with the same values.
    const key = computeChangeKey(inputs, allOutputs);
    if (key === lastRenderedKeyRef.current) return;
    lastRenderedKeyRef.current = key;

    const payload = buildTemplatePayload({ inputs: inputValues, outputs: flattenedOutputs });

    debouncedRequest?.({
      templateFiles,
      inputs: payload,
      generateFile,
      ...(target ? { target } : {}),
    });
  }, [inputs, inputValues, allOutputs, hasAllInputDeps, hasAllOutputDeps, unmetInputsIds, templateFiles, flattenedOutputs, generateFile, target, debouncedRequest, isDuplicate]);

  // Apply file tree updates when render data arrives
  useEffect(() => {
    if (!data) return;
    setHasRendered(true);
    if (generateFile) {
      applyFileTreeUpdate(data);
    }
  }, [data, generateFile, applyFileTreeUpdate]);

  // Early return for validation errors
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for duplicate ID error
  if (isDuplicate) {
    return <DuplicateIdError id={id} isNormalizedCollision={isNormalizedCollision} collidingId={collidingId} />
  }

  // Render UI
  return (
    <div data-testid={id}>
      {/* Show warning when waiting for input blocks to submit values */}
      {unmetInputsIds.length > 0 && (
        <div className="mb-3 text-sm text-yellow-700 flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
          <div>
            <strong>Waiting for inputs from:</strong>{' '}
            {unmetInputsIds.map((inputId, i) => (
              <span key={inputId}>
                {i > 0 && ', '}
                <code className="bg-yellow-100 px-1 rounded text-xs">{inputId}</code>
              </span>
            ))}
            <div className="text-xs mt-1 text-yellow-600">
              Submit the above input block(s) to render this template.
            </div>
          </div>
        </div>
      )}
      {/* Fall back to variable-level warning when inputsId blocks have registered but specific variables are still missing */}
      {(unmetInputDeps.length > 0 && unmetInputsIds.length === 0) || unmetOutputDeps.length > 0 ? (
        <UnmetDependenciesWarning
          blockType="template"
          unmetInputDeps={unmetInputDeps.length > 0 && unmetInputsIds.length === 0 ? unmetInputDeps : []}
          unmetOutputDeps={unmetOutputDeps}
        />
      ) : null}

      {error ? (
        <ErrorDisplay error={error} />
      ) : !hasRendered ? (
        <LoadingDisplay message="Waiting for template to render..." />
      ) : isLoading ? (
        <LoadingDisplay message="Rendering template..." />
      ) : data?.renderedFiles ? (
        <>
          {Object.entries(data.renderedFiles).map(([filename, fileData]) => (
            <CodeFile
              key={filename}
              fileName={fileData.name}
              filePath={fileData.path}
              code={fileData.content}
              language={fileData.language}
              showLineNumbers={true}
              showCopyCodeButton={true}
              showCopyPathButton={true}
            />
          ))}
        </>
      ) : (
        <LoadingDisplay message="Waiting for template to render..." />
      )}
    </div>
  )
}

// Set displayName for React DevTools and component detection
TemplateInline.displayName = 'TemplateInline';

export default TemplateInline;
