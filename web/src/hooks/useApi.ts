import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createAppError, type AppError } from '../types/error';
import { useApi as useApiContext } from '../contexts/ApiContext';

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

/**
 * Map from legacy HTTP endpoints to IPC channel names.
 */
const ENDPOINT_TO_CHANNEL: Record<string, string> = {
  '/api/runbook': 'runbook:get',
  '/api/runbook/executables': 'runbook:executables',
  '/api/file': 'file:read',
  '/api/generated-files/check': 'generated-files:check',
  '/api/generated-files/delete': 'generated-files:delete',
  '/api/boilerplate/variables': 'boilerplate:variables',
  '/api/boilerplate/render': 'boilerplate:render',
  '/api/boilerplate/render-inline': 'boilerplate:render-inline',
  '/api/session': 'session:get',
  '/api/session/env': 'session:set-env',
  '/api/session/join': 'session:join',
  '/api/session/reset': 'session:reset',
  '/api/telemetry/config': 'telemetry:config',
  '/api/workspace/tree': 'workspace:tree',
  '/api/workspace/dirs': 'workspace:dirs',
  '/api/workspace/file': 'workspace:file',
  '/api/workspace/changes': 'workspace:changes',
  '/api/workspace/register': 'workspace:register',
  '/api/workspace/set-active': 'workspace:set-active',
  '/api/aws/validate': 'aws:validate',
  '/api/aws/profiles': 'aws:profiles',
  '/api/aws/sso/start': 'aws:sso-start',
  '/api/aws/sso/poll': 'aws:sso-poll',
  '/api/aws/sso/complete': 'aws:sso-complete',
  '/api/aws/sso/roles': 'aws:sso-roles',
  '/api/aws/env-credentials': 'aws:env-credentials',
  '/api/aws/env-credentials/confirm': 'aws:env-credentials-confirm',
  '/api/aws/profile': 'aws:profile-auth',
  '/api/aws/check-region': 'aws:check-region',
  '/api/github/validate': 'github:validate',
  '/api/github/oauth/start': 'github:oauth-start',
  '/api/github/oauth/poll': 'github:oauth-poll',
  '/api/github/env-credentials': 'github:env-credentials',
  '/api/github/cli-credentials': 'github:cli-credentials',
  '/api/github/orgs': 'github:orgs',
  '/api/github/repos': 'github:repos',
  '/api/github/refs': 'github:refs',
  '/api/github/labels': 'github:labels',
  '/api/git/clone': 'git:clone',
  '/api/git/push': 'git:push',
  '/api/git/pull-request': 'git:pull-request',
  '/api/git/branch': 'git:delete-branch',
  '/api/exec': 'exec:run',
};

function resolveChannel(endpoint: string): string | null {
  if (!endpoint) return null;
  return ENDPOINT_TO_CHANNEL[endpoint] ?? null;
}

/**
 * Hook that wraps IPC calls. All /api/* endpoints are mapped to IPC channels
 * via ENDPOINT_TO_CHANNEL.
 */
export function useApi<T>(
  endpoint: string,
  _method: HttpMethod = 'GET',
  body?: Record<string, unknown>,
  debounceTimeout?: number,
  _extraHeaders?: Record<string, string>,
  /** When true, skip the initial auto-fetch. Requests are only made via debouncedRequest / refetch. */
  lazy?: boolean
): UseApiReturn<T> {
  const api = useApiContext();
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(!lazy);
  const [error, setError] = useState<AppError | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const bodyRef = useRef(body);
  bodyRef.current = body;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bodyKey = useMemo(() => JSON.stringify(body), [JSON.stringify(body)]);

  const channel = useMemo(() => resolveChannel(endpoint), [endpoint]);

  const performInvoke = useCallback(async (requestBody?: Record<string, unknown>) => {
    if (!channel) {
      console.log('[useApi] performInvoke skipped: no channel', { endpoint });
      setIsLoading(false);
      return;
    }

    console.log('[useApi] invoking', channel, requestBody);
    try {
      const result = await (api as any).invoke(channel, requestBody ?? undefined);
      console.log('[useApi] resolved', channel, { hasResult: result !== undefined });
      setData(result as T);
      setError(null);
    } catch (err: unknown) {
      console.error('[useApi] rejected', channel, err);
      setError(createAppError(
        err instanceof Error ? err.message : 'An unexpected error occurred',
        `IPC call to ${channel} failed`,
      ));
    } finally {
      setIsLoading(false);
    }
  }, [api, channel, endpoint]);

  const debouncedRequest = useCallback((newBody?: Record<string, unknown>) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      await performInvoke(newBody);
    }, debounceTimeout || 0);
  }, [debounceTimeout, performInvoke]);

  const refetch = useCallback(() => {
    setIsLoading(true);
    setError(null);
    performInvoke(bodyRef.current);
  }, [performInvoke]);

  const silentRefetch = useCallback(() => {
    setError(null);
    performInvoke(bodyRef.current);
  }, [performInvoke]);

  useEffect(() => {
    if (!endpoint || lazy || !channel) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    performInvoke(bodyRef.current);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [endpoint, performInvoke, bodyKey, channel, lazy]);

  return { data, isLoading, error, debouncedRequest, refetch, silentRefetch };
}
