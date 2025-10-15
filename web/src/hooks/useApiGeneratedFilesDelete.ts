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
  deleteFiles: () => Promise<void>;
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

  const deleteFiles = useCallback(async () => {
    setIsDeleting(true);
    setDeleteError(null);
    setDeleteSuccess(null);

    try {
      const response = await fetch('/api/generated-files/delete', {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        setDeleteError({
          message: errorData?.error || 'Failed to delete files',
          details: errorData?.details,
        });
        setIsDeleting(false);
        return;
      }

      const data: GeneratedFilesDeleteResult = await response.json();
      setDeleteSuccess(data);
      setIsDeleting(false);
    } catch (err) {
      setDeleteError({
        message: 'Failed to delete files',
        details: err instanceof Error ? err.message : 'Unknown error',
      });
      setIsDeleting(false);
    }
  }, []);

  return {
    deleteFiles,
    isDeleting,
    deleteError,
    deleteSuccess,
  };
}

