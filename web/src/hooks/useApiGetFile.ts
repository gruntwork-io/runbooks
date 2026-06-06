import { useMemo } from 'react';
import { useIpc } from './useIpc';
import type { UseIpcReturn } from './useIpc';

// API response wrapper for hooks that specifically request file data
export interface GetFileReturn {
  path: string;
  content: string;
  contentHash: string;
  language: string;
  size: number;
  isWatchMode?: boolean;
  warnings?: string[];
  /** The original remote URL when the runbook was opened from a remote source */
  remoteSource?: string;
}

export function useGetFile(path: string, shouldFetch: boolean = true): UseIpcReturn<GetFileReturn> {
  const shouldActuallyFetch = shouldFetch && Boolean(path);
  
  // Build the request body with the path, memoized to prevent infinite loops
  const requestBody = useMemo(() => {
    return shouldActuallyFetch ? { path } : undefined;
  }, [path, shouldActuallyFetch]);
  
  // Use empty channel when we shouldn't fetch (prevents the IPC call)
  return useIpc<GetFileReturn>(
    shouldActuallyFetch ? 'file:read' : '',
    requestBody
  );
}
