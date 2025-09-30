import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';
import { useMemo, useState, useCallback, useRef } from 'react';
import { useFileTree } from './useFileTree';

interface BoilerplateRenderResult {
  message:      string,
  outputDir:    string,
  templatePath: string,
  fileTree:     FileTree,
}

type FileTree = CodeFileData[]

interface CodeFileData {
  id: string,
  name: string,
  type: string,
  children: CodeFileData[],
  filePath: string,
  code: string,
  language: string,
  size: number,
}

// Enhanced return type that includes auto-rendering functionality
interface UseApiBoilerplateRenderResult extends UseApiReturn<BoilerplateRenderResult> {
  isAutoRendering: boolean;
  autoRender: (templatePath: string, variables: Record<string, unknown>) => void;
}

// API response wrapper for hooks that specifically request the runbook file data
export function useApiBoilerplateRender(
  templatePath: string, 
  variables?: Record<string, unknown>,
  shouldFetch: boolean = true
): UseApiBoilerplateRenderResult {
  const [isAutoRendering, setIsAutoRendering] = useState(false);    // Auto-render automatically renders new boilerplate templates on updates to the form
  const { setFileTree } = useFileTree();  // The FileTree is where we render the list of generated files
  const autoRenderTimeoutRef = useRef<NodeJS.Timeout | null>(null); // We use de-bouncing based on this timeout before we hit the API again.

  // Build the request body based on which input is provided
  const requestBody = useMemo(() => {   
    if (!shouldFetch) {
      return null; // Don't make request if shouldFetch is false
    }
    
    if (templatePath) {
      return { templatePath, variables };
    }
    
    return null; // No valid input provided
  }, [templatePath, variables, shouldFetch]);

  const apiResult = useApi<BoilerplateRenderResult>(
    shouldFetch ? '/api/boilerplate/render' : '', // Empty endpoint when shouldFetch is false
    'POST', 
    requestBody || undefined
  );

  // Auto-render function for real-time updates with debouncing
  const autoRender = useCallback((templatePath: string, variables: Record<string, unknown>) => {
    // Clear any existing re-render timeout
    if (autoRenderTimeoutRef.current) {
      clearTimeout(autoRenderTimeoutRef.current);
      autoRenderTimeoutRef.current = null;
    }

    // Set up debounced auto-render (200ms delay)
    autoRenderTimeoutRef.current = setTimeout(async () => {
      setIsAutoRendering(true);

      try {
        const response = await fetch('/api/boilerplate/render', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            templatePath,
            variables,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          console.error('Auto-render failed:', errorData.error || `Failed to auto-render files: ${response.statusText}`);
          return;
        }

        const data = await response.json();
        
        // Update the file tree data in the global context (only if successful)
        if (data.fileTree && Array.isArray(data.fileTree)) {
          setFileTree(data.fileTree);
        }
      } catch (fetchError) {
        console.error('Network error occurred while auto-rendering files:', fetchError);
      } finally {
        setIsAutoRendering(false);
      }
    }, 200); // 200ms debounce delay
  }, [setFileTree]);

  return {
    ...apiResult,
    isAutoRendering,
    autoRender
  };
}