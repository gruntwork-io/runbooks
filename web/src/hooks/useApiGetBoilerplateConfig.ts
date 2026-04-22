import { useMemo } from 'react';
import { useApi } from './useApi';
import { useServiceCall } from './useServiceCall';
import type { UseApiReturn } from './useApi';
import type { BoilerplateConfig } from '@/types/boilerplateConfig';
import * as BoilerplateService from '@/bindings/github.com/gruntwork-io/runbooks/services/boilerplateservice';
import { isDesktop } from '@/lib/wails';

// Requests the parsed variables (and output-dependency metadata) for a
// boilerplate.yml. Accepts either a templatePath (resolved relative to
// the open gruntbook) or raw boilerplateContent. shouldFetch gates both
// branches so consumers can conditionally skip without breaking the
// Rules of Hooks.
export function useApiGetBoilerplateConfig(
  templatePath?: string,
  boilerplateContent?: string,
  shouldFetch: boolean = true
): UseApiReturn<BoilerplateConfig> {
  const hasInput = Boolean(templatePath || boilerplateContent);
  const shouldActuallyFetch = shouldFetch && hasInput;

  // Browser mode: HTTP remains the source of truth until M5 removes Gin.
  const requestBody = useMemo(() => {
    if (!shouldActuallyFetch) return undefined;
    if (templatePath) return { templatePath };
    if (boilerplateContent) return { boilerplateContent };
    return undefined;
  }, [templatePath, boilerplateContent, shouldActuallyFetch]);

  const httpResult = useApi<BoilerplateConfig>(
    !isDesktop() && shouldActuallyFetch ? '/api/boilerplate/variables' : '',
    'POST',
    requestBody,
  );

  // Desktop mode: IPC binding. `lazy` suppresses the auto-fetch unless
  // we actually want to call the service right now.
  const ipcResult = useServiceCall<BoilerplateConfig>(
    async () => {
      const req = templatePath
        ? { templatePath }
        : { boilerplateContent: boilerplateContent ?? '' };
      const res = await BoilerplateService.ParseVariables(req);
      if (!res) throw new Error('boilerplate config was empty');
      // IPC response is a class instance; spread to a plain object.
      return { ...res } as BoilerplateConfig;
    },
    [templatePath, boilerplateContent],
    { lazy: !(isDesktop() && shouldActuallyFetch) },
  );

  return isDesktop() ? ipcResult : httpResult;
}
