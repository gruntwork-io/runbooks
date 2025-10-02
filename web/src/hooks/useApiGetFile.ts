import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';

// API response wrapper for hooks that specifically request file data
export interface GetFileReturn {
  path: string;
  content: string;
}

export function useGetFile(path: string): UseApiReturn<GetFileReturn> {
  // Build the endpoint with the path as a query parameter
  const endpoint = path ? `/api/file?path=${encodeURIComponent(path)}` : '';
  return useApi<GetFileReturn>(endpoint);
}
