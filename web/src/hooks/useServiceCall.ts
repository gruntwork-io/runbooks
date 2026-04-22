import { useCallback, useEffect, useRef, useState } from 'react';
import { createAppError } from '../types/error';
import type { UseApiReturn } from './useApi';

export interface UseServiceCallOptions {
  /** When true, skip the initial auto-fetch. Requests are only made via debouncedRequest / refetch. */
  lazy?: boolean;
  /** If set, debouncedRequest waits this many ms before firing. */
  debounce?: number;
}

/**
 * Wails IPC equivalent of useApi. Preserves the same return shape so
 * feature hooks migrate with a one-line body change:
 *
 *   // Before: useApi<Runbook>('/api/runbook', 'GET')
 *   // After:  useServiceCall(() => RunbookService.Load(path), [path])
 *
 * `fn` is the IPC call; `deps` control when to re-fetch (same role as
 * endpoint+body change in useApi). The latest `fn` identity is always
 * read via ref, so callers don't need to memoize it.
 */
export function useServiceCall<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts: UseServiceCallOptions = {}
): UseApiReturn<T> {
  const { lazy = false, debounce = 0 } = opts;

  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(!lazy);
  const [error, setError] = useState<UseApiReturn<T>['error']>(null);

  const fnRef = useRef(fn);
  fnRef.current = fn;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async () => {
    try {
      const result = await fnRef.current();
      setData(result);
      setError(null);
    } catch (err: unknown) {
      setError(
        createAppError(
          err instanceof Error ? err.message : 'An unexpected error occurred',
          'Service call failed'
        )
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refetch = useCallback(() => {
    setIsLoading(true);
    setError(null);
    void run();
  }, [run]);

  const silentRefetch = useCallback(() => {
    setError(null);
    void run();
  }, [run]);

  const debouncedRequest = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setIsLoading(true);
      setError(null);
      void run();
    }, debounce);
  }, [debounce, run]);

  useEffect(() => {
    if (lazy) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    void run();
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, isLoading, error, refetch, silentRefetch, debouncedRequest };
}
