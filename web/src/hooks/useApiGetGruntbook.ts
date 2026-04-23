import { useApi } from './useApi';
import { useServiceCall } from './useServiceCall';
import type { UseApiReturn } from './useApi';
import type { GetFileReturn } from './useApiGetFile';
import * as RunbookService from '@/bindings/github.com/gruntwork-io/runbooks/services/runbookservice';
import { isDesktop } from '@/lib/wails';

/**
 * API response wrapper for hooks that specifically request the gruntbook file data
 */
export function useGetGruntbook(): UseApiReturn<GetFileReturn> {
  const httpResult = useApi<GetFileReturn>(!isDesktop() ? '/api/gruntbook' : '');

  const ipcResult = useServiceCall<GetFileReturn>(
    async () => {
      const res = await RunbookService.Gruntbook();
      if (!res) throw new Error('gruntbook not available');
      // IPC response is a class instance; spread to a plain object so
      // callers can rely on the GetFileReturn shape without prototype quirks.
      return { ...res };
    },
    [],
    { lazy: !isDesktop() },
  );

  return isDesktop() ? ipcResult : httpResult;
}
