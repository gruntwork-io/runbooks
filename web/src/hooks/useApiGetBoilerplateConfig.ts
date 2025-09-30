import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';
import { useMemo } from 'react';
import type { BoilerplateConfig } from '@/types/boilerplateConfig';

// API response wrapper for hooks that specifically request the runbook file data
export function useApiGetBoilerplateConfig(
  templatePath?: string, 
  boilerplateContent?: string,
  shouldFetch: boolean = true
): UseApiReturn<BoilerplateConfig> {

  // Build the request body based on which input is provided
  const requestBody = useMemo(() => {   
    if (!shouldFetch) {
      return null; // Don't make request if shouldFetch is false
    }
    
    if (templatePath) {
      return { templatePath };
    }
    
    if (boilerplateContent) {
      return { boilerplateContent };
    }
    
    return null; // No valid input provided
  }, [templatePath, boilerplateContent, shouldFetch]);

  const apiResult = useApi<BoilerplateConfig>(
    shouldFetch ? '/api/boilerplate/variables' : '', // Empty endpoint when shouldFetch is false
    'POST', 
    requestBody || undefined
  );

  // Return validation error if present, otherwise return API result 
  return apiResult;
}