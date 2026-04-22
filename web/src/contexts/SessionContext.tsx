import { useCallback, useEffect, useState, useRef, type ReactNode } from 'react'
import { SessionContext } from './SessionContext.types'
import * as SessionService from '@/bindings/github.com/gruntwork-io/runbooks/services/sessionservice'
import { isDesktop } from '@/lib/wails'

interface SessionTokenResponse {
  token: string
}

interface SessionProviderProps {
  children: ReactNode
}

/**
 * Provider component that manages session lifecycle for the persistent environment model.
 *
 * Session flow:
 * 1. On mount: Try to join existing session
 * 2. If session exists: Get a new token for this tab
 * 3. If no session exists: Create new session
 * 4. Store token in memory only (cleared on tab close for security)
 *
 * Desktop (Wails) mode calls SessionService bindings directly; browser
 * mode falls back to the /api/session HTTP endpoints. M5 removes the
 * HTTP path when Gin goes away.
 */
export function SessionProvider({ children }: SessionProviderProps) {
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // Token is stored in a ref to avoid re-renders when it changes
  // and to keep it out of React DevTools (security)
  const tokenRef = useRef<string | null>(null)

  // Track if initialization has started to prevent double-init in StrictMode
  const initStartedRef = useRef(false)

  // Create a new session
  const createSession = useCallback(async (): Promise<SessionTokenResponse | null> => {
    try {
      if (isDesktop()) {
        const result = await SessionService.Create()
        if (!result) return null
        return { token: result.token }
      }
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.status}`)
      }

      const data: SessionTokenResponse = await response.json()
      return data
    } catch (err) {
      console.error('[SessionContext] Failed to create session:', err)
      return null
    }
  }, [])

  // Join an existing session (for new tabs connecting to an existing session)
  const joinSession = useCallback(async (): Promise<SessionTokenResponse | null> => {
    try {
      if (isDesktop()) {
        const result = await SessionService.Join()
        if (!result) return null
        return { token: result.token }
      }
      const response = await fetch('/api/session/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        // 401 means no session exists on the server
        if (response.status === 401) {
          return null
        }
        throw new Error(`Failed to join session: ${response.status}`)
      }

      const data: SessionTokenResponse = await response.json()
      return data
    } catch (err) {
      // Desktop "no gruntbook is open" / missing session is an expected
      // state during bootstrap — treat it like the HTTP 401 path.
      if (isDesktop()) {
        return null
      }
      console.error('[SessionContext] Failed to join session:', err)
      return null
    }
  }, [])

  // Initialize session on mount
  useEffect(() => {
    // Prevent double initialization in StrictMode
    if (initStartedRef.current) {
      return
    }
    initStartedRef.current = true

    const initSession = async () => {
      try {
        // Always try to join first - this allows multiple tabs to share the same session
        console.log('[SessionContext] Attempting to join existing session')
        const joined = await joinSession()

        if (joined) {
          console.log('[SessionContext] Joined existing session')
          tokenRef.current = joined.token
          setIsReady(true)
          return
        }

        // No session exists, create a new one
        console.log('[SessionContext] No session exists, creating new session')
        const newSession = await createSession()

        if (newSession) {
          console.log('[SessionContext] Session created')
          tokenRef.current = newSession.token
          setIsReady(true)
        } else {
          throw new Error('Failed to create session')
        }
      } catch (err) {
        console.error('[SessionContext] Session initialization failed:', err)
        setError(err instanceof Error ? err : new Error(String(err)))
        // Still mark as ready so the app doesn't hang, but session features won't work
        setIsReady(true)
      }
    }

    initSession()
  }, [createSession, joinSession])

  // Get the Authorization header for authenticated requests
  const getAuthHeader = useCallback((): { Authorization: string } | Record<string, never> => {
    if (tokenRef.current) {
      return { Authorization: `Bearer ${tokenRef.current}` }
    }
    return {}
  }, [])

  const getToken = useCallback((): string | null => tokenRef.current, [])

  // Reset the session to its initial environment state
  const resetSession = useCallback(async (): Promise<void> => {
    if (!tokenRef.current) {
      console.warn('[SessionContext] Cannot reset session: no active session')
      return
    }

    try {
      if (isDesktop()) {
        await SessionService.Reset(tokenRef.current)
        console.log('[SessionContext] Session reset successfully')
        return
      }

      const response = await fetch('/api/session/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenRef.current}`,
        },
      })

      if (!response.ok) {
        throw new Error(`Failed to reset session: ${response.status}`)
      }

      console.log('[SessionContext] Session reset successfully')
    } catch (err) {
      console.error('[SessionContext] Failed to reset session:', err)
      throw err
    }
  }, [])

  return (
    <SessionContext.Provider value={{ isReady, getAuthHeader, getToken, resetSession, error }}>
      {children}
    </SessionContext.Provider>
  )
}
