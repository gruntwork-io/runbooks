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
    <div className={cn("flex items-center gap-1 text-xs text-gray-500", className)}>
      <Folder className="w-3.5 h-3.5" />
      <code className="font-mono text-gray-600" title={copyPath ?? displayText}>
        {displayText}
      </code>
      {copyPath && (
        <button
          onClick={() => copy(copyPath)}
          className="p-0.5 text-gray-400 hover:text-gray-600 rounded cursor-pointer"
          title={`Copy full path: ${copyPath}`}
        >
          {didCopy ? (
            <Check className="w-3 h-3 text-green-600" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
        </button>
      )}
    </div>
  )
}
