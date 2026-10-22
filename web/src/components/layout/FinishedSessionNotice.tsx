import { Flag, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatTimeAgo } from "@/lib/relativeTime"

interface FinishedSessionNoticeProps {
  /** The name of the new session the runbook opened in */
  sessionName: string
  /** The session the runbook was finished in, which the new one replaces */
  finishedSession: { name: string; finishedAt: string }
  onSwitchSession: () => void
  onDismiss: () => void
}

/**
 * Tells the user that opening the runbook started a new session because they
 * finished the runbook in its last one, and offers the saved sessions, the
 * finished one among them, to switch to.
 */
export function FinishedSessionNotice({
  sessionName,
  finishedSession,
  onSwitchSession,
  onDismiss,
}: FinishedSessionNoticeProps) {
  const finishedAgo = formatTimeAgo(finishedSession.finishedAt)
  return (
    <div
      role="status"
      className="flex w-full items-start gap-3 rounded-md border border-info/40 bg-info-muted px-4 py-3 text-sm"
    >
      <Flag className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium text-foreground">New session {sessionName}</p>
        <p className="m-0 mt-0.5 text-muted-foreground">
          You finished this runbook in session {finishedSession.name} ({finishedAgo}), so it opened
          in a new one. The finished session is still saved.
        </p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onSwitchSession}>
        Switch session…
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
