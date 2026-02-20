import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/_shared/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/_shared/components/ErrorDisplay'
import { UnmetOutputDependenciesWarning } from '@/components/mdx/_shared/components/UnmetOutputDependenciesWarning'
import { UnmetInputDependenciesWarning } from '@/components/mdx/_shared/components/UnmetInputDependenciesWarning'
import { useInputs, useAllOutputs, inputsToValues, useRunbookContext } from '@/contexts/useRunbook'
import type { AppError } from '@/types/error'
import { extractTemplateVariables } from './lib/extractTemplateVariables'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import { extractOutputDependencies, extractOutputDependenciesFromString } from './lib/extractOutputDependencies'
import type { FileTreeNode, File } from '@/components/artifacts/code/FileTree'
import { useFileTree } from '@/hooks/useFileTree'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import { CodeFile } from '@/components/artifacts/code/CodeFile'
import { AlertTriangle } from 'lucide-react'
import { allDependenciesSatisfied, buildInputsWithBlocks, computeUnmetOutputDependencies } from '@/lib/templateUtils'
import { normalizeBlockId } from '@/lib/utils'

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
  // Render state
  const [renderState, setRenderState] = useState<'waiting' | 'rendered'>('waiting');
  const [renderData, setRenderData] = useState<{ renderedFiles: Record<string, File> } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  
  // Track last rendered variables to prevent duplicate renders
  const lastRenderedVariablesRef = useRef<string | null>(null);
  
  // Debounce timer ref for auto-updates
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Get file tree for merging (Generated tab) and worktree context for invalidation (All files tab)
  const { setFileTree } = useFileTree();
  const { invalidateTree } = useGitWorkTree();

  // Get inputs for API requests and derive values map for lookups
  const inputs = useInputs(inputsId);
  const inputValues = useMemo(() => inputsToValues(inputs), [inputs]);

  // Track which inputsId blocks haven't registered values yet (for the waiting message)
  const { blockInputs } = useRunbookContext();
  const unmetInputsIds = useMemo(() => {
    if (!inputsId) return [];
    const ids = Array.isArray(inputsId) ? inputsId : [inputsId];
    return ids.filter(id => !blockInputs[id]);
  }, [inputsId, blockInputs]);
  
  // Get all block outputs to check dependencies and pass to template rendering
  const allOutputs = useAllOutputs();
  
  // Extract input dependencies from template content
  const inputDependencies = useMemo(() => {
    return extractTemplateVariables(children);
  }, [children]);
  
  // Extract output dependencies from template content ({{ ._blocks.*.outputs.* }} patterns)
  // Also extract from outputPath so TemplateInline waits for those outputs before rendering.
  const outputDependencies = useMemo(() => {
    const childDeps = extractOutputDependencies(children);
    const pathDeps = outputPath ? extractOutputDependenciesFromString(outputPath) : [];
    if (pathDeps.length === 0) return childDeps;
    // Deduplicate by fullPath
    const seen = new Set(childDeps.map(d => d.fullPath));
    const merged = [...childDeps];
    for (const dep of pathDeps) {
      if (!seen.has(dep.fullPath)) {
        seen.add(dep.fullPath);
        merged.push(dep);
      }
    }
    return merged;
  }, [children, outputPath]);

  // Resolve {{ ._blocks.*.outputs.* }} expressions in outputPath using block outputs.
  // This enables dynamic file paths like "{{ ._blocks.target_path.outputs.path }}/terragrunt.hcl".
  const resolvedOutputPath = useMemo(() => {
    if (!outputPath) return outputPath;
    return outputPath.replace(
      /\{\{\s*\._blocks\.([a-zA-Z0-9_-]+)\.outputs\.(\w+)\s*\}\}/g,
      (_match, blockId, outputName) => {
        const nid = normalizeBlockId(blockId);
        const blockData = allOutputs[nid];
        return blockData?.values?.[outputName] ?? '';
      }
    );
  }, [outputPath, allOutputs]);

  // Compute unmet output dependencies
  const unmetOutputDependencies = useMemo(
    () => computeUnmetOutputDependencies(outputDependencies, allOutputs),
    [outputDependencies, allOutputs]
  );

  // Check if all output dependencies are satisfied
  const hasAllOutputDependencies = unmetOutputDependencies.length === 0;

  // Extract template content from children
  // MDX compiles code blocks into a nested React element structure (pre > code > text),
  // so we need to traverse it to extract the actual content. Returns a Record because
  // the Boilerplate API expects a files map (filename → content), even for a single file.
  // Uses resolvedOutputPath so dynamic expressions are resolved before file naming.
  const templateFiles = useMemo(() => {
    return extractTemplateFiles(children, resolvedOutputPath);
  }, [children, resolvedOutputPath]);
  
  const hasAllInputDependencies = useCallback(
    (vars: Record<string, unknown>): boolean => allDependenciesSatisfied(inputDependencies, vars),
    [inputDependencies]
  );
  
  // Core render function that calls the API
  const renderTemplate = useCallback(async (isAutoUpdate: boolean = false): Promise<FileTreeNode[]> => {
    // Only show loading state for initial renders, not auto-updates
    if (!isAutoUpdate) {
      setIsRendering(true);
    }
    setError(null);

    // Build inputs array including _blocks namespace for output access
    const inputsWithBlocks = buildInputsWithBlocks(inputs, allOutputs);
    
    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          templateFiles,
          // Send inputs with name, type, and value for proper type conversion
          // Includes _blocks namespace for output access
          inputs: inputsWithBlocks,
          generateFile,
          // Target specifies where output is written: "generated" (default) or "worktree"
          ...(target ? { target } : {}),
          // Note: outputPath is already used to name the file in templateFiles,
          // so we don't need to send it separately for directory determination
        }),
      });

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
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      
      setError({
        message: 'Failed to render template',
        details: errorMessage
      });
      setIsRendering(false);
      return [];
    }
  }, [templateFiles, inputs, generateFile, allOutputs, target]);
  
  // Render when imported values or outputs change (handles both initial render and updates)
  const hasTriggeredInitialRender = useRef(false);
  
  useEffect(() => {
    // Check if we have all input dependencies
    if (!hasAllInputDependencies(inputValues)) {
      return;
    }
    
    // Check if we have all output dependencies
    if (!hasAllOutputDependencies) {
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
      lastRenderedVariablesRef.current = combinedKey;
      hasTriggeredInitialRender.current = true;
      
      renderTemplate(!isInitialRender)
        .then(newFileTree => {
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
  }, [inputValues, inputs, allOutputs, hasAllInputDependencies, hasAllOutputDependencies, outputPath, renderTemplate, setFileTree, generateFile, target, invalidateTree]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current);
      }
    };
  }, []);
  
  // Check if there are any unmet input dependencies
  const hasUnmetInputDependencies = inputDependencies.length > 0 && !hasAllInputDependencies(inputValues);

  // Render UI
  return (
    <div>
      {/* Show warning when waiting for input blocks to submit values */}
      {hasUnmetInputDependencies && unmetInputsIds.length > 0 && (
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
      {hasUnmetInputDependencies && unmetInputsIds.length === 0 && (
        <UnmetInputDependenciesWarning
          blockType="template"
          inputDependencies={inputDependencies}
          inputValues={inputValues}
        />
      )}
      
      {/* Show warning for unmet output dependencies */}
      {!hasUnmetInputDependencies && !hasAllOutputDependencies && (
        <UnmetOutputDependenciesWarning unmetOutputDependencies={unmetOutputDependencies} />
      )}
      
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

