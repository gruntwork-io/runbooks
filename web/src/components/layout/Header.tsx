import { useState, type ComponentType } from 'react';
import { ChevronDown, Download, Info, Check, FolderOpen, Copy, type LucideProps } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { useLogs } from '@/contexts/useLogs';
import { getDirectoryPath } from '@/lib/utils';
import {
  createLogsZipRaw,
  createLogsZipJson,
  downloadBlob,
  generateAllLogsZipFilename,
} from '@/lib/logs';

function CopyButton({ onClick, didCopy, icon: Icon, size, className }: {
  onClick: () => void;
  didCopy: boolean;
  icon: ComponentType<LucideProps>;
  size: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-shrink-0 rounded transition-colors cursor-pointer ${className ?? ''}`}
      aria-label="Copy local path"
    >
      {didCopy ? <Check className={`${size} text-green-600`} /> : <Icon className={`${size} text-gray-400`} />}
    </button>
  );
}

interface HeaderProps {
  pathName: string;
  /** The local filesystem path (may differ from pathName when viewing a remote runbook) */
  localPath?: string;
}

/**
 * A fixed header component that displays the branding and current file path.
 *
 * The header uses a responsive design where mobile devices show only the file path
 * centered, while desktop devices show the full layout with branding and navigation.
 *
 * When viewing a remote runbook, pathName will be the remote URL while localPath
 * will be the temp directory path. A copy button is shown to copy the local path.
 *
 * @param props - The component props
 * @param props.pathName - The display string (remote URL or local path) for the header
 * @param props.localPath - The local filesystem path (for copy button when remote)
 */
export function Header({ pathName, localPath }: HeaderProps) {
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);
  const { getAllLogs, hasLogs } = useLogs();
  const { didCopy, copy } = useCopyToClipboard();

  // Show the copy-local-path button when we have a local path that differs from the display name
  // (i.e., when viewing a remote runbook)
  const isRemote = localPath && localPath !== pathName;
  const localDir = getDirectoryPath(localPath) || localPath;

  // Strip protocol prefix for compact display on small viewports
  const shortPathName = pathName.replace(/^https?:\/\//, '');

  const handleDownloadRaw = async () => {
    const logsMap = getAllLogs();
    const blob = await createLogsZipRaw(logsMap);
    downloadBlob(blob, generateAllLogsZipFilename());
  };

  const handleDownloadJson = async () => {
    const logsMap = getAllLogs();
    const blob = await createLogsZipJson(logsMap);
    downloadBlob(blob, generateAllLogsZipFilename());
  };

  return (
    <>
      <header className="w-full border-b border-gray-300 p-4 text-gray-500 font-semibold flex fixed top-0 left-0 right-0 z-10 bg-bg-default min-h-16">
        <div className="absolute left-5 top-1/2 transform -translate-y-1/2">
          <img src="/runbooks-logo-dark-alpha.svg" alt="Gruntwork Runbooks" className="h-8" />
        </div>
        <div className="flex-1 flex items-center gap-1.5 justify-end md:justify-center min-w-0 ml-12 mr-4 md:mx-40">
          <div className="hidden md:block text-sm text-gray-500 font-mono font-normal truncate max-w-full" title={pathName}>
            {pathName}
          </div>
          <div className="md:hidden text-xs text-gray-500 font-mono font-normal truncate max-w-full" title={pathName}>
            {shortPathName}
          </div>
          {isRemote && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <CopyButton onClick={() => copy(localDir || '')} didCopy={didCopy} icon={FolderOpen} size="size-3.5" className="p-1 hover:bg-gray-100" />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-sm">
                  <p className="text-xs font-medium mb-1">Local path:</p>
                  <div className="flex items-start gap-1.5">
                    <p className="text-xs text-gray-400 font-mono break-all">{localDir}</p>
                    <CopyButton onClick={() => copy(localDir || '')} didCopy={didCopy} icon={Copy} size="size-3" className="p-0.5 hover:bg-white/10" />
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <div className="hidden md:block md:absolute md:right-5 md:top-1/2 md:transform md:-translate-y-1/2 font-normal text-md">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-1 cursor-pointer hover:text-gray-700 transition-colors">
              Menu
              <ChevronDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={handleDownloadRaw}
                disabled={!hasLogs}
                className={!hasLogs ? 'opacity-50 cursor-not-allowed' : ''}
              >
                <Download className="size-4" />
                Download logs (Raw)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleDownloadJson}
                disabled={!hasLogs}
                className={!hasLogs ? 'opacity-50 cursor-not-allowed' : ''}
              >
                <Download className="size-4" />
                Download logs (JSON)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setIsAboutDialogOpen(true)}>
                <Info className="size-4" />
                About
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <AlertDialog open={isAboutDialogOpen} onOpenChange={setIsAboutDialogOpen}>
        <AlertDialogContent>
          <div className="relative">
            <AlertDialogHeader>
              <AlertDialogTitle className="sr-only">About Gruntwork Runbooks</AlertDialogTitle>
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
