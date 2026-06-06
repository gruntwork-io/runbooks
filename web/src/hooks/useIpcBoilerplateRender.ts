import { useMemo, useCallback, useEffect } from 'react'
import { useIpc } from './useIpc'
import type { UseIpcReturn } from './useIpc'
import { useFileTreeUpdater } from '@/components/mdx/_shared/hooks/useFileTreeUpdater'
import type { FileTreeNode } from '@/components/artifacts/code/FileTree'
import type { HeavyDir } from '@/contexts/GeneratedFilesContext.types'

interface BoilerplateRenderResult {
  message: string
  outputDir: string
  templatePath: string
  fileTree: FileTreeNode[]
  totalFiles?: number
  truncatedTree?: boolean
  heavyDirs?: HeavyDir[]
  deletedFiles?: string[]
  createdFiles?: string[]
  modifiedFiles?: string[]
  skippedFiles?: string[]
}

// Enhanced return type that includes auto-rendering functionality
interface UseIpcBoilerplateRenderResult extends UseIpcReturn<BoilerplateRenderResult> {
  isAutoRendering: boolean
  autoRender: (templatePath: string, variables: Record<string, unknown>) => void
}

/**
 * IPC hook for rendering boilerplate templates.
 *
 * @param templatePath - Path to the boilerplate template directory (required)
 * @param templateId - Unique ID of the Template component (required)
 * @param variables - Variables to pass to the template
 * @param shouldFetch - Whether to fetch immediately (default: true)
 * @param target - Where template output is written: "generated" (default) or "worktree"
 */
export function useIpcBoilerplateRender(
  templatePath: string,
  templateId: string,
  variables?: Record<string, unknown>,
  shouldFetch: boolean = true,
  target?: 'generated' | 'worktree'
): UseIpcBoilerplateRenderResult {
  const { applyFileTreeUpdate } = useFileTreeUpdater(target)

  const params = useMemo(() => {
    if (!shouldFetch) return undefined
    if (templatePath && templateId) {
      return { templatePath, templateId, variables, ...(target ? { target } : {}) }
    }
    return undefined
  }, [templatePath, templateId, variables, shouldFetch, target])

  const ipcResult = useIpc<BoilerplateRenderResult>(
    shouldFetch ? 'boilerplate:render' : '',
    params,
    { debounceMs: 200, disabled: !shouldFetch || !templatePath || !templateId }
  )

  const { debouncedRequest } = ipcResult
  const autoRender = useCallback((templatePath: string, variables: Record<string, unknown>) => {
    if (debouncedRequest && templatePath && templateId) {
      debouncedRequest({ templatePath, templateId, variables, ...(target ? { target } : {}) })
    }
  }, [debouncedRequest, templateId, target])

  // Handle file tree updates when data changes
  const renderData = ipcResult.data
  useEffect(() => {
    if (renderData?.fileTree && Array.isArray(renderData.fileTree)) {
      applyFileTreeUpdate(renderData)
    }
  }, [renderData, applyFileTreeUpdate])

  return {
    ...ipcResult,
    isAutoRendering: ipcResult.isLoading,
    autoRender,
  }
}
