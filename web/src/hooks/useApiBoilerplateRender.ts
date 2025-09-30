import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';
import { useMemo } from 'react';

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

// API response wrapper for hooks that specifically request the runbook file data
export function useApiBoilerplateRender(
  templatePath: string, 
  variables?: Record<string, unknown>,
  shouldFetch: boolean = true
): UseApiReturn<BoilerplateRenderResult> {

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

  return apiResult;
}