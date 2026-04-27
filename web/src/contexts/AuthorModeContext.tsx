/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Events } from '@wailsio/runtime'
import { isDesktop } from '@/lib/wails'

/**
 * AuthorModeContext exposes the consumer-vs-author runtime toggle.
 *
 * Consumer Mode (default): file edits surface as a non-blocking drift
 * banner; the user decides when to reload. The executable registry is
 * enforced and runtime block IDs / parse-error verbosity stay quiet.
 *
 * Author Mode: file edits hot-reload the gruntbook on every save, and
 * the chrome surfaces an "Author Mode" badge so the user always knows
 * they are in the auto-reload posture.
 *
 * Initial state is read from `WelcomeService.Status().initialAuthorMode`
 * (set by `gruntbooks watch` / `--author`). At runtime, the macOS View
 * menu emits `author-mode:toggle`, which flips this context's state.
 *
 * Important caveat: backend ServerConfig (UseExecutableRegistry,
 * IsWatchMode) is locked at launch — toggling here only changes the
 * frontend's reaction to file events. The registry stays as it was at
 * open time. Documented as a known M5 limitation; cleanly toggling at
 * runtime would require restarting the embedded Gin server.
 */
interface AuthorModeContextValue {
  isAuthorMode: boolean
  setAuthorMode: (next: boolean) => void
  toggleAuthorMode: () => void
  /**
   * Has the user seen the first-run explainer dialog? Persisted to
   * localStorage so we only show the explainer once per machine.
   */
  hasSeenExplainer: boolean
  markExplainerSeen: () => void
}

export const AuthorModeContext = createContext<AuthorModeContextValue | undefined>(undefined)

const EXPLAINER_STORAGE_KEY = 'gruntbooks.authorMode.explainerSeen'

interface AuthorModeProviderProps {
  /** Initial Author Mode state, sourced from Status().initialAuthorMode. */
  initialAuthorMode: boolean
  children: ReactNode
}

export function AuthorModeProvider({ initialAuthorMode, children }: AuthorModeProviderProps) {
  const [isAuthorMode, setIsAuthorMode] = useState(initialAuthorMode)
  const [hasSeenExplainer, setHasSeenExplainer] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(EXPLAINER_STORAGE_KEY) === '1'
  })

  const setAuthorMode = useCallback((next: boolean) => {
    setIsAuthorMode(next)
  }, [])

  const toggleAuthorMode = useCallback(() => {
    setIsAuthorMode((prev) => !prev)
  }, [])

  const markExplainerSeen = useCallback(() => {
    setHasSeenExplainer(true)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(EXPLAINER_STORAGE_KEY, '1')
      } catch {
        // Private-mode Safari throws on setItem; the explainer will just
        // show again next launch, which is harmless.
      }
    }
  }, [])

  // The macOS View menu fires `author-mode:toggle`. Wire it once on
  // mount; the listener uses the latest setter via setIsAuthorMode's
  // functional form so the closure captured here stays valid.
  useEffect(() => {
    if (!isDesktop()) return
    const off = Events.On('author-mode:toggle', () => {
      setIsAuthorMode((prev) => !prev)
    })
    return () => {
      off()
    }
  }, [])

  return (
    <AuthorModeContext.Provider
      value={{
        isAuthorMode,
        setAuthorMode,
        toggleAuthorMode,
        hasSeenExplainer,
        markExplainerSeen,
      }}
    >
      {children}
    </AuthorModeContext.Provider>
  )
}
