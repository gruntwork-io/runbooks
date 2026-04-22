import { type ComponentType, type ComponentPropsWithRef } from 'react';
import { ChevronDown, Download, Check, FolderOpen, Copy, X, type LucideProps } from 'lucide-react';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

function CopyButton({ onClick, didCopy, icon: Icon, size, className, ref, ...props }: {
  didCopy: boolean;
  icon: ComponentType<LucideProps>;
  size: string;
} & ComponentPropsWithRef<'button'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-shrink-0 rounded transition-colors cursor-pointer ${className ?? ''}`}
      aria-label="Copy local path"
      {...props}
      ref={ref}
    >
      {didCopy ? <Check className={`${size} text-green-600`} /> : <Icon className={`${size} text-gray-400`} />}
    </button>
  );
}

interface HeaderProps {
  pathName: string;
  /** The local filesystem path (may differ from pathName when viewing a remote gruntbook) */
  localPath?: string;
  /** When set, renders a close (X) button alongside the menu. Desktop-only. */
  onClose?: () => void;
}

/**
 * A fixed header component that displays the branding and current file path.
 *
 * The header uses a responsive design where mobile devices show only the file path
 * centered, while desktop devices show the full layout with branding and navigation.
 *
 * When viewing a remote gruntbook, pathName will be the remote URL while localPath
 * will be the temp directory path. A copy button is shown to copy the local path.
 *
 * @param props - The component props
 * @param props.pathName - The display string (remote URL or local path) for the header
 * @param props.localPath - The local filesystem path (for copy button when remote)
 */
export function Header({ pathName, localPath, onClose }: HeaderProps) {
  const { getAllLogs, hasLogs } = useLogs();
  const { didCopy, copy } = useCopyToClipboard();

  // Show the copy-local-path button when we have a local path that differs from the display name
  // (i.e., when viewing a remote gruntbook)
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
    <header className="w-full border-b border-gray-300 px-4 py-3 text-gray-500 font-semibold flex items-center gap-3 fixed top-0 left-0 right-0 z-10 bg-bg-default min-h-16">
      <div className="flex-none">
        <img src="/gruntbooks-logo-dark-alpha.svg" alt="Gruntwork Gruntbooks" className="h-8" />
      </div>
      <div className="flex-1 flex items-center gap-1.5 min-w-0">
        <div className="text-sm text-gray-500 font-mono font-normal truncate" title={pathName}>
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
      <div className="flex-none flex items-center gap-2 font-normal text-md">
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
          </DropdownMenuContent>
        </DropdownMenu>
        {onClose && (
          <button
            type="button"
            aria-label="Close gruntbook"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100 text-gray-500 hover:text-gray-900 transition-colors cursor-pointer"
          >
            <X className="size-5" />
          </button>
        )}
      </div>
    </header>
  );
}
