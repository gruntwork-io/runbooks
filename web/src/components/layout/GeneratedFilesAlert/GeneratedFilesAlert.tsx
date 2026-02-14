import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import { useApiGeneratedFilesDelete } from '../../../hooks/useApiGeneratedFilesDelete';
import { dismissGeneratedFilesAlert } from './utils';

/**
 * Alert dialog that warns users about existing generated files in the output directory.
 * 
 * When a runbook with boilerplate templates is loaded, this component checks if files
 * already exist in the output directory and prompts the user to either keep or delete them.
 * This prevents accidental overwrites and conflicts with newly generated files.
 * 
 * Features:
 * - Displays file count and output directory path
 * - Allows users to delete existing files via API call
 * - "Don't ask again" option stored in localStorage
 * - Shows success/error states after delete operation
 */
interface GeneratedFilesAlertProps {
  isOpen: boolean;
  fileCount: number;
  absoluteOutputPath: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function GeneratedFilesAlert({
  isOpen,
  fileCount,
  absoluteOutputPath,
  onClose,
  onDeleted,
}: GeneratedFilesAlertProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const { deleteFiles, isDeleting, deleteError, deleteSuccess } = useApiGeneratedFilesDelete();

  const handleKeepFiles = () => {
    if (dontAskAgain) {
      dismissGeneratedFilesAlert();
    }
    onClose();
  };

  const handleDeleteFiles = async () => {
    await deleteFiles();
    
    // Check if deletion was successful
    if (!deleteError) {
      if (dontAskAgain) {
        dismissGeneratedFilesAlert();
      }
      onDeleted();
    }
  };

  // Show success or error state in the dialog
  if (deleteSuccess) {
    return (
      <AlertDialog open={isOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Files Deleted Successfully</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSuccess.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={handleKeepFiles}>
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (deleteError) {
    return (
      <AlertDialog open={isOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Failed to Delete Files</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteError.message}
              {deleteError.details && (
                <div className="mt-2 text-sm text-muted-foreground">
                  {deleteError.details}
                </div>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={handleKeepFiles}>
              Close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open={isOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Existing Generated Files Detected</AlertDialogTitle>
          <AlertDialogDescription>
            There {fileCount === 1 ? 'is' : 'are'} {fileCount} file{fileCount === 1 ? '' : 's'} in{' '}
            the <code className="px-1 py-0.5 bg-muted rounded text-sm break-all">{absoluteOutputPath}/</code> directory. {fileCount === 1 ? 'This' : 'These'} may
            conflict with the files you generate from the current runbook. Would you like to delete the existing file{fileCount === 1 ? '' : 's'}?
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center space-x-2 py-2">
          <input
            type="checkbox"
            id="dont-ask-again"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <label htmlFor="dont-ask-again" className="text-sm cursor-pointer">
            Don't ask me again
          </label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleKeepFiles} disabled={isDeleting}>
            Keep Files
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDeleteFiles}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? 'Deleting...' : 'Delete Files'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

