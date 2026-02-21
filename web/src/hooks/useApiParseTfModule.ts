import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';
import { useMemo } from 'react';
import type { BoilerplateConfig } from '@/types/boilerplateConfig';

/**
 * Hook to parse an OpenTofu module and return a BoilerplateConfig.
 * Calls POST /api/tf/parse with the module source.
 *
 * The source can be a local relative path (e.g., "../modules/vpc") or a remote
 * URL in any supported format (GitHub shorthand, git:: prefix, browser URLs).
 */
export function useApiParseTfModule(
  source?: string,
  shouldFetch: boolean = true
): UseApiReturn<BoilerplateConfig> {
  const requestBody = useMemo(() => {
    if (!shouldFetch || !source) {
      return undefined;
    }
    return { source };
  }, [source, shouldFetch]);

  return useApi<BoilerplateConfig>(
    shouldFetch && source ? '/api/tf/parse' : '',
    'POST',
    requestBody
  );
}
