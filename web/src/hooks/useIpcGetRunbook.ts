import { useIpc } from './useIpc'
import type { UseIpcReturn } from './useIpc'
import type { GetFileReturn } from './useApiGetFile'

/**
 * IPC hook to fetch the runbook file data.
 * Replaces useGetRunbook which used HTTP GET /api/runbook.
 */
export function useIpcGetRunbook(): UseIpcReturn<GetFileReturn> {
  return useIpc<GetFileReturn>('runbook:get')
}
