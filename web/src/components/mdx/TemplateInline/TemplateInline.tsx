import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/_shared/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/_shared/components/ErrorDisplay'
import { useImportedVarValues, useGeneratedYaml } from '@/contexts/useBlockVariables'
import type { AppError } from '@/types/error'
import { extractTemplateVariables } from './lib/extractTemplateVariables'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
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
  
  // NEW: Use simplified hooks from BlockVariablesContext
  // These automatically handle merging when inputsId is an array
  const importedVarValues = useImportedVarValues(inputsId);
  const boilerplateYaml = useGeneratedYaml(inputsId);
  
  // Extract required variables from template content
  const requiredVariables = useMemo(() => {
    return extractTemplateVariables(children);
  }, [children]);
  
  // Extract template content from children
  // MDX compiles code blocks into a nested React element structure (pre > code > text),
  // so we need to traverse it to extract the actual content. Returns a Record because
  // the Boilerplate API expects a files map (filename → content), even for a single file.
  const templateFiles = useMemo(() => {
    const files = extractTemplateFiles(children, outputPath);
    
    // Include merged boilerplate.yml so backend knows variable types
    if (boilerplateYaml && boilerplateYaml !== 'variables: []') {
      files['boilerplate.yml'] = boilerplateYaml;
    }
    
    return files;
  }, [children, outputPath, boilerplateYaml]);
  
  // Helper to check if all required variables are present
  const hasAllRequiredVariables = useCallback((vars: Record<string, unknown>): boolean => {
    if (requiredVariables.length === 0) return true;
    
    return requiredVariables.every(varName => {
      const value = vars[varName];
      return value !== undefined && value !== null && value !== '';
    });
  }, [requiredVariables]);
  
  // Core render function that calls the API
  const renderTemplate = useCallback(async (vars: Record<string, unknown>, isAutoUpdate: boolean = false): Promise<FileTreeNode[]> => {
    // Only show loading state for initial renders, not auto-updates
    if (!isAutoUpdate) {
      setIsRendering(true);
    }
    setError(null);
    
    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          templateFiles, 
          variables: vars,
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
  }, [templateFiles, generateFile]);
  
  // Render when imported values change (handles both initial render and updates)
  const hasTriggeredInitialRender = useRef(false);
  
  useEffect(() => {
    // Check if we have all required variables
    // Note that TemplateInline is a pure consumer of variables, so it only has importedVarValues
    if (!hasAllRequiredVariables(importedVarValues)) {
      return;
    }
    
    // Check if values actually changed
    const valuesKey = JSON.stringify(importedVarValues);
    if (valuesKey === lastRenderedVariablesRef.current) {
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
      lastRenderedVariablesRef.current = valuesKey;
      hasTriggeredInitialRender.current = true;
      
      renderTemplate(importedVarValues, !isInitialRender)
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
  }, [importedVarValues, hasAllRequiredVariables, outputPath, renderTemplate, setFileTree, generateFile]);
  
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
    renderState === 'waiting' ? (
      <LoadingDisplay message="Fill in the variables above and click the Submit button to render this code snippet." />
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
    )
  )
}

// Set displayName for React DevTools and component detection
TemplateInline.displayName = 'TemplateInline';

export default TemplateInline;

