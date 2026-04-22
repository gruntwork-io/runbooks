import { useCallback, useEffect, useState } from 'react'
import { Welcome } from './pages/Welcome'
import { RunbookView } from './pages/RunbookView'
import * as WelcomeService from './bindings/github.com/gruntwork-io/runbooks/services/welcomeservice'
import type { OpenResult } from './bindings/github.com/gruntwork-io/runbooks/services/models'
import { isDesktop } from './lib/wails'

/**
 * Top-level view state. The browser path (served by `gruntbooks open`
 * via Gin) has no Welcome screen — it lands straight on the runbook.
 * The desktop path boots through Status() to decide:
 *
 *   - gruntbookOpen=true (unused today but ready for a future where the
 *     backend starts before the window renders) → runbook
 *   - initialPath non-empty (`gruntbooks desktop PATH`) → auto-open,
 *     then runbook
 *   - otherwise → welcome
 *
 * 'error' is only reachable from the auto-open path; the Welcome screen
 * owns its own inline error UI for user-initiated opens.
 */
type AppState =
  | { kind: 'booting' }
  | { kind: 'welcome' }
  | { kind: 'runbook'; result: OpenResult }
  | { kind: 'error'; message: string }

function App() {
  const [state, setState] = useState<AppState>(() =>
    isDesktop() ? { kind: 'booting' } : { kind: 'runbook', result: browserOpenResult() },
  )

  useEffect(() => {
    if (state.kind !== 'booting') return

    let cancelled = false
    ;(async () => {
      try {
        const status = await WelcomeService.Status()
        if (cancelled) return

        if (status.gruntbookOpen) {
          setState({
            kind: 'runbook',
            result: {
              gruntbookPath: status.gruntbookPath,
              displayPath: status.gruntbookPath,
              port: status.serverPort,
            },
          })
          return
        }

        if (status.initialPath) {
          const result = await WelcomeService.OpenLocal(status.initialPath)
          if (cancelled) return
          if (!result) {
            throw new Error('backend returned no result')
          }
          setState({ kind: 'runbook', result })
          return
        }

        setState({ kind: 'welcome' })
      } catch (err) {
        if (cancelled) return
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [state.kind])

  const handleOpened = useCallback((result: OpenResult) => {
    setState({ kind: 'runbook', result })
  }, [])

  const handleBackToWelcome = useCallback(() => {
    setState({ kind: 'welcome' })
  }, [])

  if (state.kind === 'booting') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading Gruntbooks…</p>
        </div>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-semibold mb-2">Couldn’t open that gruntbook</h2>
          <p className="text-muted-foreground mb-6">{state.message}</p>
          <button
            type="button"
            onClick={handleBackToWelcome}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 cursor-pointer"
          >
            Back to Welcome
          </button>
        </div>
      </div>
    )
  }

  if (state.kind === 'welcome') {
    return <Welcome onOpened={handleOpened} />
  }

  return <RunbookView />
}

/**
 * browserOpenResult synthesises an OpenResult for the browser path,
 * where there is no Welcome screen and the backend is already running
 * on the same origin. The values are placeholders — RunbookView reads
 * the actual gruntbook data via the HTTP endpoints that Gin serves
 * directly when running in browser mode.
 */
function browserOpenResult(): OpenResult {
  return {
    gruntbookPath: '',
    displayPath: '',
    port: 0,
  }
}

export default App
