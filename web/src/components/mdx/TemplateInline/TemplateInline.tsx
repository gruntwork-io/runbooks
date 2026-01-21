import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/_shared/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/_shared/components/ErrorDisplay'
import { UnmetOutputDependenciesWarning } from '@/components/mdx/_shared/components/UnmetOutputDependenciesWarning'
import type { UnmetOutputDependency } from '@/components/mdx/_shared/hooks/useScriptExecution'
import { useInputs, useAllOutputs, inputsToValues } from '@/contexts/useRunbook'
import type { AppError } from '@/types/error'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'
import { extractTemplateVariables } from './lib/extractTemplateVariables'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import { extractOutputDependencies, groupDependenciesByBlock } from './lib/extractOutputDependencies'
import type { FileTreeNode, File } from '@/components/artifacts/code/FileTree'
import { useFileTree } from '@/hooks/useFileTree'
import { CodeFile } from '@/components/artifacts/code/CodeFile'

interface TemplateInlineProps {
  /** ID or array of IDs of Inputs components to get variable values from. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Output path prefix for generated files */
  outputPath?: string
  /** Whether to generate the file to the file tree (default: false, preview only) */
  generateFile?: boolean
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
  
  // Get file tree for merging
  const { setFileTree } = useFileTree();
  
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
  const unmetOutputDependencies = useMemo((): UnmetOutputDependency[] => {
    if (outputDependencies.length === 0) return [];
    
    // Group dependencies by block ID
    const byBlock = groupDependenciesByBlock(outputDependencies);
    const unmet: UnmetOutputDependency[] = [];
    
    for (const [blockId, outputNames] of byBlock) {
      // Normalize block ID: hyphens → underscores (matches how outputs are stored)
      const normalizedBlockId = blockId.replace(/-/g, '_');
      const blockData = allOutputs[normalizedBlockId];
      
      if (!blockData) {
        // Block hasn't produced any outputs yet
        unmet.push({ blockId, outputNames });
      } else {
        // Check which specific outputs are missing
        const missingOutputs = outputNames.filter(name => !(name in blockData.values));
        if (missingOutputs.length > 0) {
          unmet.push({ blockId, outputNames: missingOutputs });
        }
      }
    }
    
    return unmet;
  }, [outputDependencies, allOutputs]);
  
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
  const buildBlocksNamespace = useCallback((): Record<string, { outputs: Record<string, string> }> => {
    const blocksNamespace: Record<string, { outputs: Record<string, string> }> = {};
    for (const [blockId, data] of Object.entries(allOutputs)) {
      blocksNamespace[blockId] = { outputs: data.values };
    }
    return blocksNamespace;
  }, [allOutputs]);
  
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
      { name: '_blocks', type: BoilerplateVariableType.Map, value: buildBlocksNamespace() }
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
  }, [templateFiles, inputs, generateFile, buildBlocksNamespace]);
  
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
          // Only update file tree if generateFile is true
          // The backend returns the complete output directory tree, so we simply replace
          if (generateFile) {
            setFileTree(newFileTree);
          }
        })
        .catch(err => {
          console.error(`[TemplateInline][${outputPath}] Render failed:`, err);
        });
    }, delay);
  }, [inputValues, inputs, allOutputs, hasAllInputDependencies, hasAllOutputDependencies, outputPath, renderTemplate, setFileTree, generateFile]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current);
      }
    };
  }, []);
  
  // Render UI
  return (
    <div>
      {/* Show warning for unmet output dependencies */}
      {!hasAllOutputDependencies && (
        <UnmetOutputDependenciesWarning unmetOutputDependencies={unmetOutputDependencies} />
      )}
      
      {renderState === 'waiting' ? (
        <LoadingDisplay message="Fill in the values above and click the Submit button to render this code snippet." />
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

