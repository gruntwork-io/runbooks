import { useMemo } from 'react'
import { useIpc } from './useIpc'
import type { UseIpcReturn } from './useIpc'
import type { BoilerplateConfig } from '@/types/boilerplateConfig'

/**
 * IPC hook to fetch boilerplate config/variables for a template.
 */
export function useIpcGetBoilerplateConfig(
  templatePath?: string,
  boilerplateContent?: string,
  shouldFetch: boolean = true
): UseIpcReturn<BoilerplateConfig> {
  const params = useMemo(() => {
    if (!shouldFetch) return undefined
    if (templatePath) return { templatePath }
    if (boilerplateContent) return { boilerplateContent }
    return undefined
  }, [templatePath, boilerplateContent, shouldFetch])

  return useIpc<BoilerplateConfig>(
    shouldFetch ? 'boilerplate:variables' : '',
    params,
    { disabled: !shouldFetch || (!templatePath && !boilerplateContent) }
  )
}
