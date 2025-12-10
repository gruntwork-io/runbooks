import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/BoilerplateInputs/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/BoilerplateInputs/components/ErrorDisplay'
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import { useBoilerplateRenderCoordinator } from '@/contexts/useBoilerplateRenderCoordinator'
import type { AppError } from '@/types/error'
import { extractTemplateVariables } from './lib/extractTemplateVariables'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import type { FileTreeNode, File } from '@/components/artifacts/code/FileTree'
import { useFileTree } from '@/hooks/useFileTree'
import { mergeFileTrees } from '@/lib/mergeFileTrees'
import { CodeFile } from '@/components/artifacts/code/CodeFile'
import { mergeBoilerplateVariables } from '@/components/mdx/shared/lib/mergeBoilerplateVariables'

interface TemplatePreviewProps {
  /** ID or array of IDs of Inputs components to get variable values from. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Output path prefix for generated files */
  outputPath?: string
  /** Inline template content (code blocks with file paths) */
  children?: ReactNode
}

/**
 * TemplatePreview renders inline template content with variable substitution.
 * It displays the rendered output as code blocks (preview only, no file generation).
 * 
 * Variables are sourced from an Inputs component referenced by inputsId.
 */
function TemplatePreview({
  inputsId,
  outputPath,
  children
}: TemplatePreviewProps) {
  // Render state: 'waiting' until first Generate, then 'rendered' for reactive updates
  const [renderState, setRenderState] = useState<'waiting' | 'rendered'>('waiting');
  const [renderData, setRenderData] = useState<{ renderedFiles: Record<string, File> } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  
  // Track last rendered variables to prevent duplicate renders
  const lastRenderedVariablesRef = useRef<string | null>(null);
  
  // Debounce timer ref for auto-updates
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Get context (variable values)
  const { variablesByInputsId, yamlContentByInputsId } = useBoilerplateVariables();
  const { registerTemplate } = useBoilerplateRenderCoordinator();
  const { setFileTree } = useFileTree();
  
  // Normalize inputsId to array for easier processing
  const inputsIds = useMemo(() => {
    if (!inputsId) return [];
    return Array.isArray(inputsId) ? inputsId : [inputsId];
  }, [inputsId]);
  
  // Get the primary inputsId for registration (first one in the array)
  const primaryInputsId = inputsIds[0];
  
  // Get the raw boilerplate YAML from context (use primary inputsId)
  const boilerplateYaml = primaryInputsId ? yamlContentByInputsId[primaryInputsId] : undefined;
  
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
    
    // If we have raw YAML from context, include it
    if (boilerplateYaml) {
      files['boilerplate.yml'] = boilerplateYaml;
    }
    
    return files;
  }, [children, outputPath, boilerplateYaml]);
  
  // Helper to check if all required variables are present
  const hasAllRequiredVariables = useCallback((vars: Record<string, unknown> | undefined): boolean => {
    if (!vars) return false;
    if (requiredVariables.length === 0) return true;
    
    return requiredVariables.every(varName => {
      const value = vars[varName];
      return value !== undefined && value !== null && value !== '';
    });
  }, [requiredVariables]);
  
  // Core render function that calls the API
  const renderTemplate = useCallback(async (variables: Record<string, unknown>, isAutoUpdate: boolean = false): Promise<FileTreeNode[]> => {
    // Only show loading state for initial renders, not auto-updates
    if (!isAutoUpdate) {
      setIsRendering(true);
    }
    setError(null);
    
    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateFiles, variables }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const appError: AppError = {
          message: errorData?.error || 'Failed to render template',
          details: errorData?.details || 'The server returned an error'
        };
        
        setError(appError);
        setIsRendering(false);
        return []; // Return empty array so coordinator can continue
      }

      const responseData = await response.json();
      
      setRenderData(responseData);
      setRenderState('rendered'); // Move to rendered state
      setIsRendering(false);
      
      // Return the file tree for coordinator to merge
      return responseData.fileTree || [];
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      
      setError({
        message: 'Failed to render template',
        details: errorMessage
      });
      setIsRendering(false);
      return []; // Return empty array so coordinator can continue
    }
  }, [templateFiles]);
  
  // 1. Register with coordinator for event-based initial render
  useEffect(() => {
    if (!primaryInputsId) {
      return; // inputsId is optional - if not provided, don't register
    }
    
    if (Object.keys(templateFiles).length === 0) {
      return; // Wait for template files to be extracted from children
    }
    
    const templateId = `${primaryInputsId}-${outputPath || 'default'}`;
    
    const unregister = registerTemplate({
      templateId,
      inputsId: primaryInputsId,
      renderFn: renderTemplate
    });
    
    return unregister;
  }, [primaryInputsId, outputPath, registerTemplate, renderTemplate, boilerplateYaml, templateFiles]);
  
  // 2. Merge variables from all inputsIds (later IDs override earlier ones)
  const mergedVariables = useMemo(() => {
    if (inputsIds.length === 0) return undefined;
    return mergeBoilerplateVariables(inputsId, variablesByInputsId);
  }, [inputsId, inputsIds.length, variablesByInputsId]);
  
  // 3. Initial render when variables become available (handles race condition where
  // Inputs submits before TemplatePreview registers with the coordinator)
  const hasTriggeredInitialRender = useRef(false);
  useEffect(() => {
    // Only trigger once, and only if we haven't rendered yet
    if (hasTriggeredInitialRender.current || renderState === 'rendered') {
      return;
    }
    
    // Check if we have all required variables
    if (!mergedVariables || !hasAllRequiredVariables(mergedVariables)) {
      return;
    }
    
    // Trigger initial render
    hasTriggeredInitialRender.current = true;
    renderTemplate(mergedVariables, false)
      .then(newFileTree => {
        setFileTree((currentFileTree: FileTreeNode[] | null) => {
          return mergeFileTrees(currentFileTree, newFileTree);
        });
      })
      .catch(err => {
        console.error(`[TemplatePreview][${primaryInputsId}][${outputPath}] Initial render failed:`, err);
      });
  }, [mergedVariables, renderState, hasAllRequiredVariables, primaryInputsId, outputPath, renderTemplate, setFileTree]);
  
  // 4. Auto-update when variables change (ONLY after initial render, debounced)
  useEffect(() => {
    // Only react to variable changes if we've rendered at least once
    if (renderState !== 'rendered') {
      return;
    }
    
    if (!mergedVariables || !hasAllRequiredVariables(mergedVariables)) {
      return;
    }
    
    // Check if variables actually changed
    const variablesKey = JSON.stringify(mergedVariables);
    if (variablesKey === lastRenderedVariablesRef.current) {
      return;
    }
    
    // Clear existing timer
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current);
    }
    
    // Debounce: wait 300ms after last change before updating
    autoUpdateTimerRef.current = setTimeout(() => {
      lastRenderedVariablesRef.current = variablesKey;
      
      // Re-render with new variables (mark as auto-update to prevent flashing)
      renderTemplate(mergedVariables, true)
        .then(newFileTree => {
          // Merge the new file tree with existing using functional update to avoid stale closure
          setFileTree((currentFileTree: FileTreeNode[] | null) => {
            return mergeFileTrees(currentFileTree, newFileTree);
          });
        })
        .catch(err => {
          // Error is already set in renderTemplate, just log for debugging
          console.error(`[TemplatePreview][${primaryInputsId}][${outputPath}] Auto-update failed:`, err);
        });
    }, 300);
  }, [mergedVariables, renderState, hasAllRequiredVariables, primaryInputsId, outputPath, renderTemplate, setFileTree]);
  
  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current);
      }
    };
  }, []);
  
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
TemplatePreview.displayName = 'TemplatePreview';

export default TemplatePreview;

