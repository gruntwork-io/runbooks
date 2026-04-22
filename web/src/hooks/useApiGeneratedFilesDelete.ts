import { useState, useCallback } from 'react';
import * as GeneratedFilesService from '@/bindings/github.com/gruntwork-io/runbooks/services/generatedfilesservice';
import { isDesktop } from '@/lib/wails';

// Response from the generated files delete API
export interface GeneratedFilesDeleteResult {
  success: boolean;
  deletedCount: number;
  message: string;
}

export interface UseApiGeneratedFilesDeleteReturn {
  deleteFiles: () => Promise<boolean>;
  isDeleting: boolean;
  deleteError: { message: string; details?: string } | null;
  deleteSuccess: GeneratedFilesDeleteResult | null;
}

// Deletes all files in the output directory. Uses IPC on desktop;
// falls back to the Gin DELETE endpoint in the browser until M5.
// Imperative (not auto-triggering) because the user clicks a button.
export function useApiGeneratedFilesDelete(): UseApiGeneratedFilesDeleteReturn {
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<{ message: string; details?: string } | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<GeneratedFilesDeleteResult | null>(null);

  const deleteFiles = useCallback(async (): Promise<boolean> => {
    setIsDeleting(true);
    setDeleteError(null);
    setDeleteSuccess(null);

    try {
      if (isDesktop()) {
        const res = await GeneratedFilesService.Delete();
        if (!res) throw new Error('generated-files delete returned empty');
        const data: GeneratedFilesDeleteResult = { ...res };
        setDeleteSuccess(data);
        setIsDeleting(false);
        return true;
      }

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
        return false;
      }

      const data: GeneratedFilesDeleteResult = await response.json();
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
