import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import gruntyImage from '/grunty_with_runbooks.png';

interface HeaderProps {
  pathName: string;
}

/**
 * A fixed header component that displays the branding and current file path.
 * 
 * The header uses a responsive design where mobile devices show only the file path
 * centered, while desktop devices show the full layout with branding and navigation.
 * 
 * @param props - The component props
 * @param props.pathName - The file path string to display in the center of the header
 */
export function Header({ pathName }: HeaderProps) {
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);

  return (
    <>
      <header className="w-full border-b border-gray-300 p-4 text-gray-500 font-semibold flex fixed top-0 left-0 right-0 z-10 bg-bg-default">
        <div className="hidden md:block md:absolute md:left-5 md:top-1/2 md:transform md:-translate-y-1/2">
          <img src="/runbooks-logo-dark-alpha.svg" alt="Gruntwork Runbooks" className="h-8" />
        </div>
        <div className="flex-1 flex items-center gap-2 justify-center">
          <div className="text-xs md:text-sm text-gray-500 font-mono font-normal">
            {pathName}
          </div>
        </div>
        <div className="hidden md:block md:absolute md:right-5 md:top-1/2 md:transform md:-translate-y-1/2 font-normal text-md hover:underline decoration-current">
          <button 
            onClick={() => setIsAboutDialogOpen(true)}
            className="cursor-pointer"
          >
            About
          </button>
        </div>
      </header>

      <AlertDialog open={isAboutDialogOpen} onOpenChange={setIsAboutDialogOpen}>
        <AlertDialogContent>
          <div className="relative">
            <AlertDialogHeader>
              <img src="/runbooks-logo-dark-color.svg" alt="Gruntwork Runbooks" className="h-16 mb-2" />
              
              <AlertDialogDescription className="text-left space-y-4">
                <p>Runbooks enables DevOps subject matter experts to capture and share their expertise in a way that is easy to understand and use.</p>
                <p>Runbooks is published by <a target="_blank" href="https://gruntwork.io">Gruntwork</a> and is <a target="_blank" href="https://github.com/gruntwork-io/runbooks">open source</a>! Check out the <a target="_blank" href="https://runbooks.gruntwork.io">Runbooks docs</a> for more information.</p>
                <AlertDialogAction className="block mt-4" onClick={() => setIsAboutDialogOpen(false)}>
                Close
                </AlertDialogAction>
              </AlertDialogDescription>
            </AlertDialogHeader>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

