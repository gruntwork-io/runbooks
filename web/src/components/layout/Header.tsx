import { type ComponentType, type ComponentPropsWithRef } from 'react';
import { ChevronDown, Download, Check, Copy, X, type LucideProps } from 'lucide-react';
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
import { useAuthorMode } from '@/contexts/useAuthorMode';
import { AuthorModeBadge } from '../AuthorModeBadge';
import { isMacOSDesktop } from '@/lib/wails';
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

// truncateToLastSegments keeps only the last n path segments, prefixing
// with '…/' when segments were dropped. Leaves short paths untouched.
function truncateToLastSegments(path: string, n: number): string {
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= n) return path;
  return '…/' + segments.slice(-n).join('/');
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
  const { isAuthorMode } = useAuthorMode();

  // Show the copy-local-path button when we have a local path that differs from the display name
  // (i.e., when viewing a remote gruntbook)
  const isRemote = localPath && localPath !== pathName;
  const localDir = getDirectoryPath(localPath) || localPath;

  // For the local case, display the containing folder (not the gruntbook
  // file itself) truncated to its last three segments so the header
  // doesn't blow past the viewport on deep paths. Remote stays as the URL.
  const displayPath = isRemote
    ? pathName.replace(/^https?:\/\//, '')
    : truncateToLastSegments(getDirectoryPath(pathName) || pathName, 3);

  // The value the copy button writes to the clipboard: the full containing
  // directory, whether local or the remote gruntbook's temp checkout.
  const copyTarget = localDir || getDirectoryPath(pathName) || pathName;

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

  // On macOS the system title bar is hidden via MacTitleBarHiddenInsetUnified,
  // so the inset traffic-light buttons sit on top of our header. Pad the
  // left edge to clear them and apply the Wails drag region so users can
  // grab the header to move the window. Interactive children opt out via
  // `--wails-draggable: no-drag` so clicks still work.
  const isMac = isMacOSDesktop();
  const dragStyle = isMac ? ({ ['--wails-draggable' as string]: 'drag' } as React.CSSProperties) : undefined;
  const noDragStyle = isMac ? ({ ['--wails-draggable' as string]: 'no-drag' } as React.CSSProperties) : undefined;

  return (
    <header
      className={`w-full border-b border-gray-300 ${isMac ? 'pl-20 pr-4' : 'px-4'} py-3 text-gray-500 font-semibold grid grid-cols-[auto_1fr_auto] items-center gap-3 fixed top-0 left-0 right-0 z-10 bg-bg-default min-h-16`}
      style={dragStyle}
    >
      <div className="flex-none flex items-center gap-3">
        <img src="/gruntbooks-logo-dark-alpha.svg" alt="Gruntwork Gruntbooks" className="h-8" />
        {isAuthorMode && <AuthorModeBadge />}
      </div>
      <div className="flex items-center justify-center gap-1.5 min-w-0" style={noDragStyle}>
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="text-sm text-gray-500 font-mono font-normal truncate"
                title={copyTarget}
              >
                {displayPath}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-lg">
              <p className="text-xs font-mono break-all">{copyTarget}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <CopyButton
          onClick={() => copy(copyTarget || '')}
          didCopy={didCopy}
          icon={Copy}
          size="size-3.5"
          className="p-1 hover:bg-gray-100"
        />
      </div>
      <div className="flex-none flex items-center gap-2 font-normal text-md" style={noDragStyle}>
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
