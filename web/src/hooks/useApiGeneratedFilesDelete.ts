import { useState, useCallback } from 'react';

/**
 * Response from the generated files delete API
 */
export interface GeneratedFilesDeleteResult {
  success: boolean;
  deletedCount: number;
  message: string;
}

/**
 * Return type for the delete hook
 */
export interface UseApiGeneratedFilesDeleteReturn {
  deleteFiles: () => Promise<boolean>;
  isDeleting: boolean;
  deleteError: { message: string; details?: string } | null;
  deleteSuccess: GeneratedFilesDeleteResult | null;
}

/**
 * Hook to delete generated files from the output directory
 */
export function useApiGeneratedFilesDelete(): UseApiGeneratedFilesDeleteReturn {
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<{ message: string; details?: string } | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<GeneratedFilesDeleteResult | null>(null);

  const deleteFiles = useCallback(async (): Promise<boolean> => {
    setIsDeleting(true);
    setDeleteError(null);
    setDeleteSuccess(null);

    try {
      const data = await window.api.invoke('generated-files:delete') as unknown as GeneratedFilesDeleteResult;
      setDeleteSuccess(data);
      setIsDeleting(false);
      return true;
    } catch (err) {
      setDeleteError({
        message: 'Failed to delete files',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
      setIsDeleting(false);
      return false;
    }
  }, []);

  return {
    deleteFiles,
    isDeleting,
    deleteError,
    deleteSuccess,
  };
}

