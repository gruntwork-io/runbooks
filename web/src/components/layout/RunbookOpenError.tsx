import { AlertTriangle, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RunbookOpenErrorProps {
  /** User-facing reason the open failed (may contain newlines). */
  message: string
  onChooseAnother: () => void
  onRetry: () => void
  /**
   * `fullscreen` replaces the page when no runbook has loaded yet. `inline` is
   * a dismissible banner shown while a previously opened runbook stays mounted.
   */
  variant: 'fullscreen' | 'inline'
  /** Inline only: the runbook that is still open, so it's clear nothing was replaced. */
  currentPath?: string
  /** Inline only: hides the banner. */
  onDismiss?: () => void
  className?: string
}

/**
 * "Couldn't open runbook" message with Choose Another Folder / Retry actions.
 * Both variants share one component so the first-open screen and the banner
 * shown for a later failed open can't drift apart.
 */
export function RunbookOpenError({
  message,
  onChooseAnother,
  onRetry,
  variant,
  currentPath,
  onDismiss,
  className,
}: RunbookOpenErrorProps) {
  if (variant === 'inline') {
    return (
      <div
        role="alert"
        className={cn('bg-destructive-muted border border-destructive/30 rounded-lg p-4 text-left', className)}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-5 mt-0.5 flex-shrink-0 text-destructive" />
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-destructive mb-1">Couldn't open runbook</h3>
            <p className="text-sm text-destructive whitespace-pre-line break-words">{message}</p>
            {currentPath && (
              <p className="text-sm text-destructive mt-2 break-all">
                Still showing <span className="font-mono">{currentPath}</span>
              </p>
            )}
            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={onChooseAnother}
                className="px-3 py-1.5 text-sm bg-destructive text-white rounded-md hover:bg-destructive/90 focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-2 cursor-pointer"
              >
                Choose Another Folder
              </button>
              <button
                onClick={onRetry}
                className="px-3 py-1.5 text-sm border border-destructive/40 text-destructive rounded-md hover:bg-destructive/10 focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-2 cursor-pointer"
              >
                Retry
              </button>
            </div>
          </div>
          {onDismiss && (
            <button
              onClick={onDismiss}
              aria-label="Dismiss"
              className="flex-shrink-0 p-1 rounded text-destructive hover:bg-destructive/10 cursor-pointer"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex items-center justify-center h-[calc(100vh-5rem)]', className)}>
      <div className="text-center max-w-md mx-auto p-6">
        <div className="bg-destructive-muted border border-destructive/30 rounded-lg p-6">
          <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-destructive-muted rounded-full">
            <AlertTriangle className="w-6 h-6 text-destructive" />
          </div>
          <h3 className="text-lg font-medium text-destructive mb-2">Couldn't open runbook</h3>
          <p className="text-sm text-destructive mb-6 whitespace-pre-line">{message}</p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={onChooseAnother}
              className="px-4 py-2 bg-destructive text-white rounded-md hover:bg-destructive/90 focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-2 cursor-pointer"
            >
              Choose Another Folder
            </button>
            <button
              onClick={onRetry}
              className="px-4 py-2 border border-destructive/40 text-destructive rounded-md hover:bg-destructive/10 focus:outline-none focus:ring-2 focus:ring-destructive focus:ring-offset-2 cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
