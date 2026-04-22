import { useMemo } from 'react';
import { useApi } from './useApi';
import { useServiceCall } from './useServiceCall';
import type { UseApiReturn } from './useApi';
import * as FileService from '@/bindings/github.com/gruntwork-io/runbooks/services/fileservice';
import { isDesktop } from '@/lib/wails';

// API response wrapper for hooks that specifically request file data
export interface GetFileReturn {
  path: string;
  content: string;
  contentHash: string;
  language: string;
  size: number;
  isWatchMode?: boolean;
  warnings?: string[];
  /** The original remote URL when the gruntbook was opened from a remote source */
  remoteSource?: string;
}

export function useGetFile(path: string, shouldFetch: boolean = true): UseApiReturn<GetFileReturn> {
  const shouldActuallyFetch = shouldFetch && Boolean(path);

  // Browser mode: the HTTP endpoint remains the source of truth until M5
  // removes Gin. Build the request body here so the hook short-circuits
  // when shouldActuallyFetch is false (empty endpoint skips the fetch).
  const requestBody = useMemo(() => {
    return shouldActuallyFetch ? { path } : undefined;
  }, [path, shouldActuallyFetch]);

  const httpResult = useApi<GetFileReturn>(
    !isDesktop() && shouldActuallyFetch ? '/api/file' : '',
    'POST',
    requestBody,
  );

  // Desktop mode: call the IPC binding. `lazy` prevents the auto-fetch
  // when we shouldn't be fetching yet.
  const ipcResult = useServiceCall<GetFileReturn>(
    async () => {
      const res = await FileService.Read(path);
      if (!res) throw new Error(`file not found: ${path}`);
      // IPC response is a class instance; spread to a plain object so
      // consumers can rely on the GetFileReturn shape without prototype
      // quirks.
      return { ...res };
    },
    [path],
    { lazy: !(isDesktop() && shouldActuallyFetch) },
  );

  return isDesktop() ? ipcResult : httpResult;
}
