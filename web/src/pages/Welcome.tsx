import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Clock, AlertTriangle } from 'lucide-react'
import { Events } from '@wailsio/runtime'
import { Button } from '@/components/ui/button'
import * as WelcomeService from '@/bindings/github.com/gruntwork-io/runbooks/services/welcomeservice'
import type { OpenResult, RecentEntry } from '@/bindings/github.com/gruntwork-io/runbooks/services/models'

export interface WelcomeProps {
  onOpened: (result: OpenResult) => void
}

/**
 * Welcome is the entry screen when `gruntbooks desktop` is launched
 * without a path argument. It drives the one M2 IPC surface end-to-end:
 *   - PickLocalFolder opens a native directory picker.
 *   - OpenLocal validates the chosen folder, starts the backend, and
 *     records the entry in the recent list.
 *   - ListRecent hydrates the "Recent gruntbooks" section.
 *
 * Remote URL and "Install CLI" actions are stubbed as future work and
 * will be filled in in later milestones (M3 and M5 respectively).
 */
export function Welcome({ onOpened }: WelcomeProps) {
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    WelcomeService.ListRecent().then((entries) => {
      if (!cancelled) setRecent(entries ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [])

  const openPath = useCallback(
    async (path: string) => {
      setIsBusy(true)
      setError(null)
      try {
        const result = await WelcomeService.OpenLocal(path)
        if (!result) {
          throw new Error('backend returned no result')
        }
        onOpened(result)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsBusy(false)
      }
    },
    [onOpened],
  )

  // Hold the latest openPath in a ref so the file-drop subscription
  // doesn't need to resubscribe every render.
  const openPathRef = useRef(openPath)
  useEffect(() => {
    openPathRef.current = openPath
  }, [openPath])

  useEffect(() => {
    const off = Events.On('welcome:files-dropped', (ev: { data?: { files?: string[] } }) => {
      const files = ev.data?.files ?? []
      if (files.length === 0) return
      void openPathRef.current(files[0])
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])

  const handlePickFolder = useCallback(async () => {
    setError(null)
    try {
      const path = await WelcomeService.PickLocalFolder()
      if (!path) return // user cancelled
      await openPath(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [openPath])

  return (
    <div
      data-file-drop-target
      className="min-h-screen w-full flex items-center justify-center bg-background p-6"
    >
      <div className="w-full max-w-2xl">
        <header className="text-center mb-10">
          <img
            src="/gruntbooks-logomark-dark.svg"
            alt=""
            className="mx-auto mb-4 h-20 w-auto"
          />
          <h1 className="text-4xl font-semibold tracking-tight mb-2">Gruntbooks</h1>
          <p className="text-muted-foreground text-base">
            Open a gruntbook to run it, or pick up where you left off.
          </p>
        </header>

        <section className="flex flex-col gap-3 mb-10">
          <Button
            size="lg"
            onClick={handlePickFolder}
            disabled={isBusy}
            className="h-14 text-base justify-start gap-3"
          >
            <FolderOpen className="size-5" />
            {isBusy ? 'Opening…' : 'Open local gruntbook'}
          </Button>
        </section>

        {error && (
          <div className="mb-8 flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <AlertTriangle className="size-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium mb-1">Couldn’t open that gruntbook</div>
              <div className="text-red-700">{error}</div>
            </div>
          </div>
        )}

        <section>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
            <Clock className="size-4" /> Recent
          </h2>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No recently opened gruntbooks yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border border border-border rounded-md overflow-hidden bg-card">
              {recent.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => openPath(entry.path)}
                    disabled={isBusy}
                    className="w-full text-left px-4 py-3 hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3 cursor-pointer"
                  >
                    <FolderOpen className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{entry.displayName}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {entry.path}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
