import { useMemo } from 'react';
import { useApi } from './useApi';
import { useServiceCall } from './useServiceCall';
import type { UseApiReturn } from './useApi';
import { useSession } from '@/contexts/useSession';
import type { BoilerplateConfig } from '@/types/boilerplateConfig';
import * as TfService from '@/bindings/github.com/gruntwork-io/runbooks/services/tfservice';
import { isDesktop } from '@/lib/wails';

// Parses an OpenTofu/Terraform module — local path or remote git URL —
// and returns the boilerplate-shaped variables plus module metadata
// (folder name, README title, output and resource names).
//
// Desktop mode routes through the Wails IPC TfService. Browser mode
// keeps POSTing /api/tf/parse until M5 drops Gin.
export function useApiParseTfModule(
  source?: string,
  shouldFetch: boolean = true
): UseApiReturn<BoilerplateConfig> {
  const { getAuthHeader } = useSession();
  const shouldActuallyFetch = shouldFetch && Boolean(source);

  const requestBody = useMemo(() => {
    return shouldActuallyFetch && source ? { source } : undefined;
  }, [source, shouldActuallyFetch]);

  const httpResult = useApi<BoilerplateConfig>(
    !isDesktop() && shouldActuallyFetch ? '/api/tf/parse' : '',
    'POST',
    requestBody,
    undefined,
    getAuthHeader() as Record<string, string>,
  );

  const ipcResult = useServiceCall<BoilerplateConfig>(
    async () => {
      const res = await TfService.Parse({ source: source ?? '' });
      if (!res) throw new Error('tf parse response was empty');
      // TfParseResponse is a class instance that embeds BoilerplateConfig
      // plus a metadata field — spread flattens both onto a plain object
      // matching BoilerplateConfig's optional metadata field.
      // Cast via unknown: the generated BoilerplateVarType enum and the
      // hand-written BoilerplateVariableType share runtime values but
      // TS treats them as nominally distinct.
      return { ...res } as unknown as BoilerplateConfig;
    },
    [source],
    { lazy: !(isDesktop() && shouldActuallyFetch) },
  );

  return isDesktop() ? ipcResult : httpResult;
}
