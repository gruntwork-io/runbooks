import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { ReactNode } from 'react'
import { LoadingDisplay } from '@/components/mdx/BoilerplateInputs/components/LoadingDisplay'
import { ErrorDisplay } from '@/components/mdx/BoilerplateInputs/components/ErrorDisplay'
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import { useBoilerplateRenderCoordinator } from '@/contexts/useBoilerplateRenderCoordinator'
import type { AppError } from '@/types/error'
import { extractTemplateVariables } from './lib/extractTemplateVariables'
import { extractTemplateFiles } from './lib/extractTemplateFiles'
import type { CodeFileData } from '@/components/artifacts/code/FileTree'
import { useFileTree } from '@/hooks/useFileTree'
import { mergeFileTrees } from '@/lib/mergeFileTrees'

interface BoilerplateTemplateProps {
  boilerplateInputsId: string
  outputPath?: string
  children?: ReactNode // For inline template content  
}

function BoilerplateTemplate({
  boilerplateInputsId,
  outputPath,
  children
}: BoilerplateTemplateProps) {
  // Render state: 'waiting' until first Generate, then 'rendered' for reactive updates
  const [renderState, setRenderState] = useState<'waiting' | 'rendered'>('waiting');
  const [renderData, setRenderData] = useState<{ renderedFiles: Record<string, string> } | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  
  // Track last rendered variables to prevent duplicate renders
  const lastRenderedVariablesRef = useRef<string | null>(null);
  
  // Debounce timer ref for auto-updates
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Get context
  const { variablesByInputsId, yamlContentByInputsId } = useBoilerplateVariables();
  const { registerTemplate } = useBoilerplateRenderCoordinator();
  const { setFileTree } = useFileTree();
  
  // Get the raw boilerplate YAML from context (stored by BoilerplateInputs)
  const boilerplateYaml = yamlContentByInputsId[boilerplateInputsId];
  
  // Extract required variables from template content
  const requiredVariables = useMemo(() => {
    const vars = extractTemplateVariables(children);
    console.log(`[Template][${boilerplateInputsId}][${outputPath}] Required variables:`, vars);
    return vars;
  }, [children, boilerplateInputsId, outputPath]);
  
  // Extract template files from children
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
  const renderTemplate = useCallback(async (variables: Record<string, unknown>, isAutoUpdate: boolean = false): Promise<CodeFileData[]> => {
    console.log(`[Template][${boilerplateInputsId}][${outputPath}] Rendering with variables:`, variables, isAutoUpdate ? '(auto-update)' : '(initial)');
    
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
      
      console.log(`[Template][${boilerplateInputsId}][${outputPath}] Render successful`);
      
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
  }, [boilerplateInputsId, outputPath, templateFiles]);
  
  // 1. Register with coordinator for event-based initial render
  useEffect(() => {
    if (!boilerplateYaml || Object.keys(templateFiles).length === 0) {
      return; // Wait for template files to be ready
    }
    
    const templateId = `${boilerplateInputsId}-${outputPath || 'default'}`;
    
    console.log(`[Template][${boilerplateInputsId}][${outputPath}] Registering with coordinator`);
    
    const unregister = registerTemplate({
      templateId,
      inputsId: boilerplateInputsId,
      renderFn: renderTemplate
    });
    
    return unregister;
  }, [boilerplateInputsId, outputPath, registerTemplate, renderTemplate, boilerplateYaml, templateFiles]);
  
  // 2. Auto-update when variables change (ONLY if already rendered, debounced)
  const contextVariables = variablesByInputsId[boilerplateInputsId];
  
  useEffect(() => {
    // Only react to variable changes if we've rendered at least once
    if (renderState !== 'rendered') {
      console.log(`[Template][${boilerplateInputsId}][${outputPath}] Skipping auto-update - state is '${renderState}'`);
      return;
    }
    
    if (!contextVariables || !hasAllRequiredVariables(contextVariables)) {
      console.log(`[Template][${boilerplateInputsId}][${outputPath}] Skipping auto-update - invalid variables`);
      return;
    }
    
    // Check if variables actually changed
    const variablesKey = JSON.stringify(contextVariables);
    if (variablesKey === lastRenderedVariablesRef.current) {
      console.log(`[Template][${boilerplateInputsId}][${outputPath}] Skipping auto-update - variables unchanged`);
      return;
    }
    
    console.log(`[Template][${boilerplateInputsId}][${outputPath}] Auto-update requested (debouncing...)`);
    
    // Clear existing timer
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current);
    }
    
    // Debounce: wait 300ms after last change before updating
    autoUpdateTimerRef.current = setTimeout(() => {
      console.log(`[Template][${boilerplateInputsId}][${outputPath}] Auto-update executing`);
      lastRenderedVariablesRef.current = variablesKey;
      
      // Re-render with new variables (mark as auto-update to prevent flashing)
      renderTemplate(contextVariables, true)
        .then(newFileTree => {
          // Merge the new file tree with existing using functional update to avoid stale closure
          setFileTree((currentFileTree: CodeFileData[] | null) => {
            const merged = mergeFileTrees(currentFileTree, newFileTree);
            console.log(`[Template][${boilerplateInputsId}][${outputPath}] File tree updated:`, merged?.length || 0, 'items');
            return merged;
          });
        })
        .catch(err => {
          // Error is already set in renderTemplate, just log for debugging
          console.error(`[Template][${boilerplateInputsId}][${outputPath}] Auto-update failed:`, err);
        });
    }, 300);
  }, [contextVariables, renderState, hasAllRequiredVariables, boilerplateInputsId, outputPath, renderTemplate, setFileTree]);
  
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
      <LoadingDisplay message="Fill in the variables above and click the Generate button to render this code snippet." />
    ) : isRendering ? (
      <LoadingDisplay message="Rendering template..." />
    ) : error ? (
      <ErrorDisplay error={error} />
    ) : renderData?.renderedFiles ? (
      <>
        {Object.entries(renderData.renderedFiles).map(([filename, content]) => (
          <div key={filename}>
            <h4>{filename}</h4>
            <pre><code>{content}</code></pre>
          </div>
        ))}
      </>
    ) : (
      <LoadingDisplay message="Waiting for template to render..." />
    )
  )
}


export default BoilerplateTemplate;