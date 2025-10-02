import { useMemo } from 'react';
import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';

// API response wrapper for hooks that specifically request file data
export interface GetFileReturn {
  path: string;
  content: string;
  language: string;
  size: number;
}

export function useGetFile(path: string): UseApiReturn<GetFileReturn> {
  // Build the request body with the path, memoized to prevent infinite loops
  const requestBody = useMemo(() => {
    return path ? { path } : undefined;
  }, [path]);
  
  return useApi<GetFileReturn>('/api/file', 'POST', requestBody);
}
