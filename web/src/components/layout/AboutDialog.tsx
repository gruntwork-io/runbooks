import logoDarkColor from '@/assets/runbooks-logo-dark-color.svg';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <div className="relative">
          <AlertDialogHeader>
            <AlertDialogTitle className="sr-only">About Gruntwork Runbooks</AlertDialogTitle>
            <img src={logoDarkColor} alt="Gruntwork Runbooks" className="h-16 mb-2" />

            <AlertDialogDescription className="text-left space-y-4">
              <p>Runbooks enables DevOps subject matter experts to capture and share their expertise in a way that is easy to understand and use.</p>
              <p>Runbooks is published by <a target="_blank" rel="noreferrer" href="https://gruntwork.io">Gruntwork</a> and is <a target="_blank" rel="noreferrer" href="https://github.com/gruntwork-io/runbooks">open source</a>! Check out the <a target="_blank" rel="noreferrer" href="https://runbooks.gruntwork.io">Runbooks docs</a> for more information.</p>
              <AlertDialogAction className="block mt-4" onClick={() => onOpenChange(false)}>
                Close
              </AlertDialogAction>
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
