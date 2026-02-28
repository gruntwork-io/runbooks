import { useState, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/_shared/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/_shared/components/ErrorDisplay'
import { UnmetDependenciesWarning } from '@/components/mdx/_shared/components/UnmetDependenciesWarning'
import { useInputs, useAllOutputs, flattenInputs, useRunbookContext } from '@/contexts/useRunbook'
import { extractTemplateDependencies, extractTemplateDependenciesFromString, splitDependencies } from '@/lib/extractTemplateDependencies'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import type { File, FileTreeNode } from '@/components/artifacts/code/FileTree'
import { useApi } from '@/hooks/useApi'
import { useFileTreeUpdater } from '../_shared/hooks/useFileTreeUpdater'
import { computeChangeKey } from '@/lib/changeDetection'
import { CodeFile } from '@/components/artifacts/code/CodeFile'
import { AlertTriangle } from 'lucide-react'
import { buildTemplatePayload, computeUnmetInputDependencies, computeUnmetOutputDependencies, flattenBlockOutputs, hasEmptyNumericInputs, resolveTemplateReferences } from '@/lib/templateUtils'

interface RenderInlineResult {
  renderedFiles: Record<string, File>
  fileTree: FileTreeNode[]
  truncatedTree?: boolean
  totalFiles?: number
  heavyDir?: string
  heavyDirFileCount?: number
}

interface TemplateInlineProps {
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
  inputsId,
  outputPath,
  generateFile = false,
  target,
  children
}: TemplateInlineProps) {
  // Render state — tracks whether we've ever rendered (for the "waiting" UI)
  const [hasRendered, setHasRendered] = useState(false);

  // Track last rendered change key to avoid duplicate renders
  const lastRenderedKeyRef = useRef<string | null>(null);

  // API hook — empty endpoint means no auto-fetch on mount; we use debouncedRequest explicitly
  const { data, error, isLoading, debouncedRequest } = useApi<RenderInlineResult>(
    '', 'POST', undefined, 300
  );

  // File tree updater — handles Generated tab vs worktree updates
  const { applyFileTreeUpdate } = useFileTreeUpdater(target);

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

  // Auto-render when inputs or outputs change
  useEffect(() => {
    if (!hasAllInputDeps || !hasAllOutputDeps) return;

    // Skip render when a numeric input is empty (user is mid-edit, e.g., clearing
    // a number field before typing a new value). Sending "" to the backend would
    // cause type-conversion errors like strconv.Atoi("").
    if (hasEmptyNumericInputs(inputs)) return;

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
  }, [inputs, inputValues, allOutputs, hasAllInputDeps, hasAllOutputDeps, templateFiles, flattenedOutputs, generateFile, target, debouncedRequest]);

  // Apply file tree updates when render data arrives
  useEffect(() => {
    if (!data) return;
    setHasRendered(true);
    if (generateFile) {
      applyFileTreeUpdate(data);
    }
  }, [data, generateFile, applyFileTreeUpdate]);

  // Render UI
  return (
    <div>
      {/* Show warning when waiting for input blocks to submit values */}
      {unmetInputDeps.length > 0 && unmetInputsIds.length > 0 && (
        <div className="mb-3 text-sm text-yellow-700 flex items-start gap-2">
          <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
          <div>
            <strong>Waiting for inputs from:</strong>{' '}
            {unmetInputsIds.map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <code className="bg-yellow-100 px-1 rounded text-xs">{id}</code>
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
