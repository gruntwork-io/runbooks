/**
 * @fileoverview LocalPathRow Component
 *
 * Displays a local filesystem path with a folder icon and an optional
 * copy-to-clipboard button. Reused in both the repository metadata bar
 * and the generated files info bar.
 */

import { Folder, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

export function LocalPathRow({ displayText, copyPath, className }: {
  /** Text shown next to the folder icon (e.g. "./my-repo" or a relative path). */
  displayText: string;
  /** Absolute path copied to clipboard. When omitted the copy button is hidden. */
  copyPath?: string;
  /** Additional CSS classes (e.g. for top margin). */
  className?: string;
}) {
  const { didCopy, copy } = useCopyToClipboard()

  return (
    <div className={cn("flex items-center gap-1 text-xs text-muted-foreground", className)}>
      <Folder className="w-3.5 h-3.5" />
      <code className="font-mono text-muted-foreground" title={copyPath ?? displayText}>
        {displayText}
      </code>
      {copyPath && (
        <button
          onClick={() => copy(copyPath)}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded cursor-pointer"
          title={`Copy full path: ${copyPath}`}
        >
          {didCopy ? (
            <Check className="w-3 h-3 text-success" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
        </button>
      )}
    </div>
  )
}
