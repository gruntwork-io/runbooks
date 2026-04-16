import { useState, useCallback } from 'react'
import { useApi } from '@/contexts/ApiContext'

/**
 * Response from the generated files delete IPC channel
 */
export interface GeneratedFilesDeleteResult {
  success: boolean
  deletedCount: number
  message: string
}

/**
 * Return type for the delete hook
 */
export interface UseIpcGeneratedFilesDeleteReturn {
  deleteFiles: () => Promise<boolean>
  isDeleting: boolean
  deleteError: { message: string; details?: string } | null
  deleteSuccess: GeneratedFilesDeleteResult | null
}

/**
 * IPC hook to delete generated files from the output directory.
 */
export function useIpcGeneratedFilesDelete(): UseIpcGeneratedFilesDeleteReturn {
  const api = useApi()
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<{ message: string; details?: string } | null>(null)
  const [deleteSuccess, setDeleteSuccess] = useState<GeneratedFilesDeleteResult | null>(null)

  const deleteFiles = useCallback(async (): Promise<boolean> => {
    setIsDeleting(true)
    setDeleteError(null)
    setDeleteSuccess(null)

    try {
      const data = await api.invoke('generated-files:delete') as unknown as GeneratedFilesDeleteResult
      setDeleteSuccess(data)
      setIsDeleting(false)
      return true
    } catch (err) {
      setDeleteError({
        message: 'Failed to delete files',
        details: err instanceof Error ? err.message : 'Unknown error',
      })
      setIsDeleting(false)
      return false
    }
  }, [api])

  return {
    deleteFiles,
    isDeleting,
    deleteError,
    deleteSuccess,
  }
}
