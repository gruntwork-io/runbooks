import { useMemo } from 'react';
import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';

// API response wrapper for hooks that specifically request file data
export interface GetFileReturn {
  path: string;
  content: string;
  language: string;
  size: number;
  isWatchMode?: boolean;
}

export function useGetFile(path: string, shouldFetch: boolean = true): UseApiReturn<GetFileReturn> {
  // Only fetch if we have a path and shouldFetch is true
  const shouldActuallyFetch = shouldFetch && Boolean(path);
  
  // Build the request body with the path, memoized to prevent infinite loops
  const requestBody = useMemo(() => {
    return shouldActuallyFetch ? { path } : undefined;
  }, [path, shouldActuallyFetch]);
  
  // Use empty endpoint when we shouldn't fetch (prevents API call)
  return useApi<GetFileReturn>(
    shouldActuallyFetch ? '/api/file' : '',
    'POST',
    requestBody
  );
}
