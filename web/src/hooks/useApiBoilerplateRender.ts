import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';
import { useMemo, useCallback, useEffect } from 'react';
import { useFileTree } from './useFileTree';
import { mergeFileTrees } from '@/lib/mergeFileTrees';

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
  type: 'file' | 'folder',
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
  const { setFileTree } = useFileTree();  // The FileTree is where we render the list of generated files

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
    requestBody || undefined,
    200 // 200ms debounce timeout
  );

  // Auto-render function using the debounced request
  const { debouncedRequest } = apiResult;
  const autoRender = useCallback((templatePath: string, variables: Record<string, unknown>) => {
    if (debouncedRequest && templatePath) { // Only auto-render if templatePath is not empty
      debouncedRequest({ templatePath, variables });
    }
  }, [debouncedRequest]);

  // Handle file tree updates when data changes
  // Use functional update to merge with existing tree and avoid stale closure issues
  useEffect(() => {
    const fileTreeData = apiResult.data?.fileTree;
    if (fileTreeData && Array.isArray(fileTreeData)) {
      setFileTree(currentFileTree => mergeFileTrees(currentFileTree, fileTreeData));
    }
  }, [apiResult.data?.fileTree, setFileTree]);

  return {
    ...apiResult,
    isAutoRendering: apiResult.isLoading,
    autoRender
  };
}