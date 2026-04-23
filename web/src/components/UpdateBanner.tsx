import { useEffect, useState } from 'react'
import { Browser, Events } from '@wailsio/runtime'
import { Download, X } from 'lucide-react'
import type { UpdateInfo } from '../bindings/github.com/gruntwork-io/runbooks/services/models'
import { isDesktop } from '../lib/wails'

/**
 * UpdateBanner subscribes to the `update:available` event emitted by
 * UpdateService and renders a non-blocking strip at the top of the
 * window when a newer Gruntbooks release is out. Dismissing hides it
 * for the rest of the session; the next restart will re-emit the event
 * if the user is still on an older version.
 *
 * Desktop-only — the browser path (gruntbooks open → Gin) has no
 * equivalent service, so the component no-ops in that environment.
 * Rendering the banner above the routed view (Welcome / RunbookView)
 * means both screens pick it up without per-page wiring.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!isDesktop()) return

    const unsubscribe = Events.On('update:available', (event: { data: UpdateInfo }) => {
      setInfo(event.data)
      setDismissed(false)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  if (!info || !info.available || dismissed) {
    return null
  }

  const handleDownload = () => {
    if (info.releaseUrl) {
      Browser.OpenURL(info.releaseUrl).catch((err) => {
        console.error('Failed to open release URL:', err)
      })
    }
  }

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-4 bg-primary/10 border-b border-primary/20 px-4 py-2 text-sm"
    >
      <span className="text-foreground">
        A new version of Gruntbooks is available (
        <span className="font-medium">{info.latestVersion}</span>). You’re on{' '}
        <span className="font-medium">{info.currentVersion}</span>.
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-primary-foreground hover:opacity-90 cursor-pointer"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss update notification"
          className="inline-flex items-center rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
