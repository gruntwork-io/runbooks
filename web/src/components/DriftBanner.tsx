import { useState } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react'
import type { DriftChange } from '@/hooks/useWatchMode'

interface DriftBannerProps {
  /**
   * Cumulative set of changes since the snapshot was taken. Empty while
   * no drift has been reported; the banner only renders when non-empty.
   */
  changes: DriftChange[]
  /**
   * Fires when the user clicks "Reload". The parent re-fetches the
   * gruntbook, resets the snapshot, and clears the drift state.
   */
  onReload: () => void
  /**
   * Fires when the user clicks the X. The banner hides but the snapshot
   * is NOT reset — the next drift event re-opens the banner with the
   * cumulative delta vs. the original open time.
   */
  onDismiss: () => void
}

const kindLabel: Record<DriftChange['kind'], string> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
}

/**
 * Non-blocking banner shown in consumer mode when the gruntbook tree has
 * drifted from the snapshot taken at open time. Protects reviewers from
 * executing scripts that changed out from under them after they read the
 * gruntbook. Reload re-baselines; Dismiss hides without re-baselining so
 * the banner re-appears on the next change with the cumulative delta.
 */
export function DriftBanner({ changes, onReload, onDismiss }: DriftBannerProps) {
  const [expanded, setExpanded] = useState(false)

  if (changes.length === 0) {
    return null
  }

  const summary =
    changes.length === 1
      ? '1 file changed since you opened this gruntbook.'
      : `${changes.length} files changed since you opened this gruntbook.`

  return (
    <div
      role="status"
      className="flex flex-col gap-2 bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-amber-900">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{summary}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-amber-900 hover:bg-amber-100 cursor-pointer"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                Hide changes <ChevronUp className="h-3.5 w-3.5" />
              </>
            ) : (
              <>
                View changes <ChevronDown className="h-3.5 w-3.5" />
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onReload}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1 text-white hover:bg-amber-700 cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss drift notification"
            className="inline-flex items-center rounded-md p-1 text-amber-800 hover:bg-amber-100 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {expanded && (
        <ul className="ml-6 list-disc text-amber-900 max-h-40 overflow-auto">
          {changes.map((c) => (
            <li key={`${c.kind}:${c.path}`}>
              <span className="font-mono">{c.path}</span>{' '}
              <span className="text-amber-700">({kindLabel[c.kind]})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
