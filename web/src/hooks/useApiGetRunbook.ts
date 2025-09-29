import { useGetFile } from './useApiGetFile';
import type { UseApiReturn } from './useApi';
import type { GetFileReturn } from './useApiGetFile';

/**
 * API response wrapper for hooks that specifically request the runbook file data
 */
export function useGetRunbook(): UseApiReturn<GetFileReturn> {
  return useGetFile('/api/runbook');
}
