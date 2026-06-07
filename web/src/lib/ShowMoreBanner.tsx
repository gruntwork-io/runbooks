import { AlertTriangle } from 'lucide-react'

interface ShowMoreBannerProps {
  /** How many items are currently visible. */
  displayedCount: number
  /** Total number of items available. */
  total: number
  /** How many more rows the button reveals when clicked. */
  remaining: number
  /** Plural noun for the items, e.g. "changed files". */
  noun: string
  onShowMore: () => void
}

/**
 * Truncation banner shown below a partially-displayed file list, with a
 * "Show N more" button. Shared by ChangedFilesView and CodeFileCollection.
 */
export function ShowMoreBanner({
  displayedCount,
  total,
  remaining,
  noun,
  onShowMore,
}: ShowMoreBannerProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-3 bg-warning-muted border border-warning/30 rounded-md">
      <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
      <span className="text-sm text-warning-foreground flex-1">
        Showing {displayedCount} of {total} {noun}.
      </span>
      <button
        type="button"
        onClick={onShowMore}
        className="px-3 py-1 text-sm bg-warning-muted hover:bg-warning-muted/80 text-warning-foreground rounded-md cursor-pointer transition-colors"
      >
        Show {remaining} more
      </button>
    </div>
  )
}
