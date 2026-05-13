import { useMemo } from 'react'
import { useIpc } from './useIpc'
import type { UseIpcReturn } from './useIpc'
import type { GetFileReturn } from './useApiGetFile'

/**
 * IPC hook to fetch file content by path.
 */
export function useIpcGetFile(path: string, shouldFetch: boolean = true): UseIpcReturn<GetFileReturn> {
  const shouldActuallyFetch = shouldFetch && Boolean(path)

  const params = useMemo(() => {
    return shouldActuallyFetch ? { path } : undefined
  }, [path, shouldActuallyFetch])

  return useIpc<GetFileReturn>(
    shouldActuallyFetch ? 'file:read' : '',
    params,
    { disabled: !shouldActuallyFetch }
  )
}
