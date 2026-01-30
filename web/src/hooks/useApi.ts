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
  debounceTimeout?: number
): UseApiReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Memoize the full URL to prevent unnecessary re-renders
  const fullUrl = useMemo(() => {
    return endpoint.startsWith('http') || endpoint.startsWith('https')
      ? endpoint 
      : `${window.location.origin}${endpoint}`;
  }, [endpoint]);

  // Shared fetch function that both useEffect and debouncedRequest can use
  const performFetch = useCallback(async (requestBody?: Record<string, unknown>) => {
    // Debug logging for boilerplate render requests
    if (endpoint.includes('boilerplate')) {
      console.log('[useApi.performFetch] About to fetch', {
        endpoint,
        requestBody,
        requestBodyVariables: requestBody?.variables,
        requestBodyRuntime: requestBody?.variables?.Runtime
      });
    }

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
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
      console.log('err', err);
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
    performFetch(body);
  }, [performFetch, body]);

  // Silent refetch function - refetches without showing loading state (for hot reloading)
  const silentRefetch = useCallback(() => {
    // Don't set isLoading to true - keep existing content visible
    setError(null);
    performFetch(body);
  }, [performFetch, body]);

  useEffect(() => {
    if (!endpoint) {
      setIsLoading(false);
      return;
    }

    // Debug logging for boilerplate render requests
    if (endpoint.includes('boilerplate')) {
      console.log('[useApi] Effect triggered for boilerplate endpoint', {
        endpoint,
        body,
        bodyVariables: body?.variables,
        bodyRuntime: body?.variables?.Runtime
      });
    }

    // Reset state when endpoint changes
    setIsLoading(true);
    setError(null);

    // Use the shared fetch function
    performFetch(body);

    // Cleanup function
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [endpoint, performFetch, body]);

  return { data, isLoading, error, debouncedRequest, refetch, silentRefetch };
}
