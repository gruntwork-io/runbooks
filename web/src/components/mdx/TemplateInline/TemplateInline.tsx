import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/_shared/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/_shared/components/ErrorDisplay'
import { UnmetDependenciesWarning } from '@/components/mdx/_shared/components/UnmetDependenciesWarning'
import { useInputs, useAllOutputs, flattenInputs, useRunbookContext } from '@/contexts/useRunbook'
import type { AppError } from '@/types/error'
import { extractTemplateDependencies, extractTemplateDependenciesFromString, splitDependencies } from '@/lib/extractTemplateDependencies'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import type { FileTreeNode, File } from '@/components/artifacts/code/FileTree'
import { useFileTree } from '@/hooks/useFileTree'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import { CodeFile } from '@/components/artifacts/code/CodeFile'
import { AlertTriangle } from 'lucide-react'
import { DuplicateIdError } from '../_shared/components/DuplicateIdError'
import { useComponentIdRegistry } from '@/contexts/ComponentIdRegistry'
import { useErrorReporting } from '@/contexts/useErrorReporting'
import { useTelemetry } from '@/contexts/useTelemetry'
import { buildTemplatePayload, computeUnmetInputDependencies, computeUnmetOutputDependencies, flattenBlockOutputs, hasEmptyNumericInputs, resolveTemplateReferences } from '@/lib/templateUtils'

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

  // Render state
  const [renderState, setRenderState] = useState<'waiting' | 'rendered'>('waiting');
  const [renderData, setRenderData] = useState<{ renderedFiles: Record<string, File> } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  // Report configuration errors (duplicate ID / normalized collision) to the shared error context.
  // Transient render/fetch errors are shown locally by ErrorDisplay.
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

  // Track last rendered variables to prevent duplicate renders
  const lastRenderedVariablesRef = useRef<string | null>(null);
  
  // Debounce timer ref for auto-updates
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Monotonic counter to discard stale render responses
  const renderVersionRef = useRef(0);
  
  // Get file tree for merging (Generated tab) and worktree context for invalidation (All files tab)
  const { setFileTree } = useFileTree();
  const { invalidateTree } = useGitWorkTree();

  // Get inputs for API requests and derive values map for lookups
  const inputs = useInputs(inputsId);
  const inputValues = useMemo(() => flattenInputs(inputs), [inputs]);

  // Track which inputsId blocks haven't registered values yet (for the waiting message)
  const { blockInputs } = useRunbookContext();
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
  
  // Core render function that calls the API.
  // Each call increments renderVersionRef; when the response arrives we check
  // that no newer render has been kicked off before applying state updates.
  const renderTemplate = useCallback(async (isAutoUpdate: boolean = false): Promise<FileTreeNode[]> => {
    const version = ++renderVersionRef.current;

    // Only show loading state for initial renders, not auto-updates
    if (!isAutoUpdate) {
      setIsRendering(true);
    }
    setError(null);

    // Build payload with inputs and outputs namespaces
    const payload = buildTemplatePayload({ inputs: inputValues, outputs: flattenedOutputs });

    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateFiles,
          // Send inputs with name, type, and value for proper type conversion
          // Includes outputs namespace for output access
          inputs: payload,
          generateFile,
          // Target specifies where output is written: "generated" (default) or "worktree"
          ...(target ? { target } : {}),
          // Note: outputPath is already used to name the file in templateFiles,
          // so we don't need to send it separately for directory determination
        }),
      });

      // A newer render was started while this one was in flight — discard.
      if (version !== renderVersionRef.current) return [];

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const appError: AppError = {
          message: errorData?.error || 'Failed to render template',
          details: errorData?.details || 'The server returned an error'
        };

        setError(appError);
        setIsRendering(false);
        return [];
      }

      const responseData = await response.json();

      setRenderData(responseData);
      setRenderState('rendered');
      setIsRendering(false);

      return responseData.fileTree || [];
    } catch (err) {
      // Discard errors from superseded requests
      if (version !== renderVersionRef.current) return [];

      const errorMessage = err instanceof Error ? err.message : 'Unknown error';

      setError({
        message: 'Failed to render template',
        details: errorMessage
      });
      setIsRendering(false);
      return [];
    }
  }, [templateFiles, inputValues, flattenedOutputs, generateFile, target]);
  
  // Render when imported values or outputs change (handles both initial render and updates)
  const hasTriggeredInitialRender = useRef(false);
  
  useEffect(() => {
    // Don't render if this is a duplicate/colliding ID
    if (isDuplicate) {
      return;
    }

    // Check if we have all input dependencies
    if (!hasAllInputDeps) {
      return;
    }

    // Check if we have all output dependencies
    if (!hasAllOutputDeps) {
      return;
    }

    // Skip render when a numeric input is empty (user is mid-edit, e.g., clearing
    // a number field before typing a new value). Sending "" to the backend would
    // cause type-conversion errors like strconv.Atoi("").
    if (hasEmptyNumericInputs(inputs)) {
      return;
    }

    // Check if inputs actually changed (includes both values and types)
    const valuesKey = JSON.stringify(inputs);
    const outputsKey = JSON.stringify(allOutputs);
    const combinedKey = `${valuesKey}|${outputsKey}`;
    
    if (combinedKey === lastRenderedVariablesRef.current) {
      return;
    }
    
    // Clear existing timer
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current);
    }
    
    // Determine if this is initial render or auto-update
    const isInitialRender = !hasTriggeredInitialRender.current;
    
    // Debounce for auto-updates, immediate for initial render
    const delay = isInitialRender ? 0 : 300;
    
    autoUpdateTimerRef.current = setTimeout(() => {
      hasTriggeredInitialRender.current = true;

      renderTemplate(!isInitialRender)
        .then(newFileTree => {
          // Only mark as rendered after a successful response.
          // On failure renderTemplate returns [] without updating state,
          // so the next effect cycle will retry with the same inputs.
          if (newFileTree && newFileTree.length > 0) {
            lastRenderedVariablesRef.current = combinedKey;
          }

          if (!generateFile) return;
          // When target is worktree, output went to the git repo — do NOT update Generated tab
          // (that would show the whole worktree including .git). Instead refresh the All files tree.
          if (target === 'worktree') {
            invalidateTree();
          } else {
            setFileTree(newFileTree);
            // Trigger immediate changelog refresh so changes appear without waiting for next poll
            invalidateTree();
          }
        })
        .catch(err => {
          console.error(`[TemplateInline][${outputPath}] Render failed:`, err);
        });
    }, delay);
  }, [isDuplicate, inputValues, inputs, allOutputs, hasAllInputDeps, hasAllOutputDeps, outputPath, renderTemplate, setFileTree, generateFile, target, invalidateTree]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current);
      }
    };
  }, []);
  
  // Early return for validation errors (e.g. missing id prop)
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
      {unmetInputDeps.length > 0 && unmetInputsIds.length > 0 && (
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
      ) : renderState === 'waiting' ? (
        <LoadingDisplay message="Waiting for template to render..." />
      ) : isRendering ? (
        <LoadingDisplay message="Rendering template..." />
      ) : renderData?.renderedFiles ? (
        <>
          {Object.entries(renderData.renderedFiles).map(([filename, fileData]) => (
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

