import { History, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatTimeAgo } from "@/lib/relativeTime"

interface SessionResumedNoticeProps {
  sessionName: string
  /** When the session was last used before it was resumed, as an ISO timestamp */
  resumedFrom: string
  /** When the runbook was finished in the session, if it was, as an ISO timestamp */
  finishedAt?: string | undefined
  onStartNew: () => void
  onDismiss: () => void
}

/**
 * Tells the user that opening the runbook resumed one of its saved sessions,
 * and offers to start a new one instead. A finished session is only resumed
 * when the user picks it.
 */
export function SessionResumedNotice({
  sessionName,
  resumedFrom,
  finishedAt,
  onStartNew,
  onDismiss,
}: SessionResumedNoticeProps) {
  return (
    <div
      role="status"
      className="flex w-full items-start gap-3 rounded-md border border-info/40 bg-info-muted px-4 py-3 text-sm"
    >
      <History className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium text-foreground">Resumed session {sessionName}</p>
        <p className="m-0 mt-0.5 text-muted-foreground">
          Last used {formatTimeAgo(resumedFrom)}. Its blocks, files and environment are as you left
          them.
          {finishedAt !== undefined &&
            ` You finished this runbook in it (${formatTimeAgo(finishedAt)}), so opening the runbook again won't resume it.`}
        </p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onStartNew}>
        Start new session
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={onDismiss}
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  )
}
