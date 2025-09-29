import { useState, useEffect, useMemo } from 'react';
import type { AppError } from '../types/error';

/**
 * API response wrapper for hooks that return data with loading and error states
 */
export interface UseApiReturn<T> {
  data: T | null;
  isLoading: boolean;
  error: AppError | null;
}

export function useApi<T>(endpoint: string): UseApiReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  // Memoize the full URL to prevent unnecessary re-renders
  const fullUrl = useMemo(() => {
    return endpoint.startsWith('http') || endpoint.startsWith('https')
      ? endpoint 
      : `${window.location.origin}${endpoint}`;
  }, [endpoint]);

  useEffect(() => {
    if (!endpoint) {
      setIsLoading(false);
      return;
    }

    // Reset state when endpoint changes
    setIsLoading(true);
    setError(null);

    // Fetch the data
    fetch(endpoint)
      .then(response => {
        if (!response.ok) {
          return response.json().then(errorData => {
            setError({
              message: errorData?.message || `HTTP error: ${response.status}`,
              details: errorData?.details || `Failed to connect to runbook server at ${fullUrl}`
            })
            setIsLoading(false);
          })  
        }
        return response.json();
      })
      .then(data => {
        setIsLoading(false);
        setData(data);
      })
      .catch(err => {
        setIsLoading(false);
        setError({
          message: err.message || 'An unexpected error occurred',
          details: `Failed to connect to runbook server at ${fullUrl}`
        });
      })

    // Cleanup function
    return () => {
    };
  }, [endpoint, fullUrl]);

  return { data, isLoading, error };
}
