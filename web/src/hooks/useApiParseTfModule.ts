import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';
import { useMemo } from 'react';
import type { BoilerplateConfig } from '@/types/boilerplateConfig';

/**
 * Hook to parse an OpenTofu module directory and return a BoilerplateConfig.
 * Calls POST /api/tofu/parse with the module path.
 */
export function useApiParseTfModule(
  modulePath?: string,
  shouldFetch: boolean = true
): UseApiReturn<BoilerplateConfig> {
  const requestBody = useMemo(() => {
    if (!shouldFetch || !modulePath) {
      return undefined;
    }
    return { modulePath };
  }, [modulePath, shouldFetch]);

  return useApi<BoilerplateConfig>(
    shouldFetch && modulePath ? '/api/tofu/parse' : '',
    'POST',
    requestBody
  );
}
