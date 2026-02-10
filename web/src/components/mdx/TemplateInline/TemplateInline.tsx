import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/_shared/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/_shared/components/ErrorDisplay'
import { UnmetOutputDependenciesWarning } from '@/components/mdx/_shared/components/UnmetOutputDependenciesWarning'
import { UnmetInputDependenciesWarning } from '@/components/mdx/_shared/components/UnmetInputDependenciesWarning'
import { useInputs, useAllOutputs, inputsToValues } from '@/contexts/useRunbook'
import type { AppError } from '@/types/error'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import { extractTemplateVariables } from './lib/extractTemplateVariables'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import { extractOutputDependencies } from './lib/extractOutputDependencies'
import type { FileTreeNode, File } from '@/components/artifacts/code/FileTree'
import { useFileTree } from '@/hooks/useFileTree'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import { CodeFile } from '@/components/artifacts/code/CodeFile'
import { buildBlocksNamespace, computeUnmetOutputDependencies } from '@/lib/templateUtils'

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
  
  // Get all block outputs to check dependencies and pass to template rendering
  const allOutputs = useAllOutputs();
  
  // Extract input dependencies from template content
  const inputDependencies = useMemo(() => {
    return extractTemplateVariables(children);
  }, [children]);
  
  // Extract output dependencies from template content ({{ ._blocks.*.outputs.* }} patterns)
  const outputDependencies = useMemo(() => {
    return extractOutputDependencies(children);
  }, [children]);
  
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
  const templateFiles = useMemo(() => {
    return extractTemplateFiles(children, outputPath);
  }, [children, outputPath]);
  
  // Helper to check if all input dependencies are satisfied
  const hasAllInputDependencies = useCallback((vars: Record<string, unknown>): boolean => {
    if (inputDependencies.length === 0) return true;
    
    return inputDependencies.every(varName => {
      const value = vars[varName];
      return value !== undefined && value !== null && value !== '';
    });
  }, [inputDependencies]);
  
  // Build the _blocks namespace for template rendering
  const blocksNamespace = useCallback(() => buildBlocksNamespace(allOutputs), [allOutputs]);
  
  // Core render function that calls the API
  const renderTemplate = useCallback(async (isAutoUpdate: boolean = false): Promise<FileTreeNode[]> => {
    // Only show loading state for initial renders, not auto-updates
    if (!isAutoUpdate) {
      setIsRendering(true);
    }
    setError(null);
    
    // Build inputs array including _blocks namespace for output access
    const inputsWithBlocks = [
      ...inputs.filter(i => i.name !== '_blocks'),
      { name: '_blocks', type: BoilerplateVariableType.Map, value: blocksNamespace() }
    ];
    
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
  }, [templateFiles, inputs, generateFile, blocksNamespace]);
  
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
      {/* Show warning for unmet input dependencies */}
      {hasUnmetInputDependencies && (
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
      
      {renderState === 'waiting' ? (
        <LoadingDisplay message="Waiting for template to render..." />
      ) : isRendering ? (
        <LoadingDisplay message="Rendering template..." />
      ) : error ? (
        <ErrorDisplay error={error} />
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

