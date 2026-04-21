import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';
import type { GetFileReturn } from './useApiGetFile';

/**
 * API response wrapper for hooks that specifically request the gruntbook file data
 */
export function useGetGruntbook(): UseApiReturn<GetFileReturn> {
  return useApi<GetFileReturn>('/api/gruntbook');
}
