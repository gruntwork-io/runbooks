import { AlertTriangle, X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface RunbookChangedNoticeProps {
  /** The runbook's file name, e.g. `runbook.mdx` */
  fileName: string
  /**
   * Launched with --disable-live-file-reload: a reload shows the new version
   * but keeps executing the commands and scripts approved at open.
   */
  registryFrozen: boolean
  onReload: () => void
  onDismiss: () => void
}

/**
 * Tells the user that the open runbook changed on disk after Runbooks loaded
 * it, and offers to reload it. Without --watch nothing reloads on its own, so
 * until they do, the runbook on screen and what Run executes stay as loaded.
 * Laid out like the session notices, in warning colors.
 */
export function RunbookChangedNotice({
  fileName,
  registryFrozen,
  onReload,
  onDismiss,
}: RunbookChangedNoticeProps) {
  return (
    <div
      role="status"
      className="flex w-full items-start gap-3 rounded-md border border-warning/30 bg-warning-muted px-4 py-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium text-foreground">Runbook changed</p>
        <p className="m-0 mt-0.5 text-muted-foreground">
          <code className="rounded px-1 text-xs">{fileName}</code> changed on disk since Runbooks
          loaded it.{" "}
          {registryFrozen
            ? "Reload to show the new version, in the same session. Run keeps the commands and scripts approved at open (--disable-live-file-reload)."
            : "Reload to show and run the new version, in the same session."}
        </p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onReload}>
        Reload runbook
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
