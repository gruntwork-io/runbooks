import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createAppError, type AppError } from '../types/error';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

// API response wrapper for hooks that return data with loading and error states
export interface UseApiReturn<T> {
  data: T | null;
  isLoading: boolean;
  error: AppError | null;
  debouncedRequest?: (newBody?: Record<string, unknown>) => void;
  refetch: () => void;
  silentRefetch: () => void;
}

export function useApi<T>(
  endpoint: string,
  method: HttpMethod = 'GET',
  body?: Record<string, unknown>,
  debounceTimeout?: number,
  extraHeaders?: Record<string, string>,
  /** When true, skip the initial auto-fetch. Requests are only made via debouncedRequest / refetch. */
  lazy?: boolean
): UseApiReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(!lazy);
  const [error, setError] = useState<AppError | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Use a ref for extraHeaders so changing the object identity doesn't trigger
  // re-fetches. Headers are config, not a fetch trigger — the latest value is
  // always read when a fetch actually happens.
  const extraHeadersRef = useRef(extraHeaders);
  extraHeadersRef.current = extraHeaders;

  // Use a ref for body so changing object identity (same content, new reference)
  // doesn't trigger re-fetches. Content changes are detected via bodyKey below.
  const bodyRef = useRef(body);
  bodyRef.current = body;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bodyKey = useMemo(() => JSON.stringify(body), [JSON.stringify(body)]);

  // Memoize the full URL to prevent unnecessary re-renders
  const fullUrl = useMemo(() => {
    return endpoint.startsWith('http') || endpoint.startsWith('https')
      ? endpoint 
      : `${window.location.origin}${endpoint}`;
  }, [endpoint]);

  // Shared fetch function that both useEffect and debouncedRequest can use
  const performFetch = useCallback(async (requestBody?: Record<string, unknown>) => {
    try {
      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...extraHeadersRef.current,
        },
      };

      if (requestBody && ['POST', 'PUT', 'PATCH'].includes(method)) {
        fetchOptions.body = JSON.stringify(requestBody);
      }

      const response = await fetch(endpoint, fetchOptions);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        setError(createAppError(
          errorData?.message || errorData?.error || `HTTP error: ${response.status}`,
          errorData?.details || `Failed to connect to runbook server at ${fullUrl}. Is the backend server running?`,
          {
            specifiedPath: errorData?.specifiedPath,
            currentWorkingDir: errorData?.currentWorkingDir,
          }
        ));
        setIsLoading(false);
        return;
      }
      
      const data = await response.json();
      setIsLoading(false);
      setData(data);
    } catch (err: unknown) {
      setIsLoading(false);
      setError(createAppError(
        err instanceof Error ? err.message : 'An unexpected error occurred',
        `Failed to connect to runbook server at ${fullUrl}`
      ));
    }
  }, [endpoint, method, fullUrl]);

  // Debounced request function
  const debouncedRequest = useCallback((newBody?: Record<string, unknown>) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      await performFetch(newBody);
    }, debounceTimeout || 0);
  }, [debounceTimeout, performFetch]);

  // Refetch function - immediately refetches with the original body
  const refetch = useCallback(() => {
    setIsLoading(true);
    setError(null);
    performFetch(bodyRef.current);
  }, [performFetch]);

  // Silent refetch function - refetches without showing loading state (for hot reloading)
  const silentRefetch = useCallback(() => {
    // Don't set isLoading to true - keep existing content visible
    setError(null);
    performFetch(bodyRef.current);
  }, [performFetch]);

  useEffect(() => {
    if (!endpoint || lazy) {
      setIsLoading(false);
      return;
    }

    // Reset state when endpoint changes
    setIsLoading(true);
    setError(null);

    // Use the shared fetch function
    performFetch(bodyRef.current);

    // Cleanup function
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [endpoint, performFetch, bodyKey]);

  return { data, isLoading, error, debouncedRequest, refetch, silentRefetch };
}
