import { useIpc } from './useIpc';
import type { UseIpcReturn } from './useIpc';
import { useMemo } from 'react';
import type { BoilerplateConfig } from '@/types/boilerplateConfig';

export function useApiGetBoilerplateConfig(
  templatePath?: string, 
  boilerplateContent?: string,
  shouldFetch: boolean = true
): UseIpcReturn<BoilerplateConfig> {

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

  return useIpc<BoilerplateConfig>(
    shouldFetch ? 'boilerplate:variables' : '', // Empty channel when shouldFetch is false
    requestBody || undefined
  );
}