import { useCallback, useEffect, useState, useRef, type ReactNode } from 'react'
import { useApi } from './ApiContext'
import { IpcSessionContext } from './IpcSessionContext.types'
import { SessionContext } from './SessionContext.types'

interface IpcSessionProviderProps {
  children: ReactNode
}

/**
 * Manages session lifecycle via Electron IPC. IPC is process-local and
 * inherently trusted, so there is no Bearer token management.
 *
 * Session flow:
 * 1. On mount: Try to join an existing session (session:join)
 * 2. If no session exists: Create a new one (session:create)
 */
export function IpcSessionProvider({ children }: IpcSessionProviderProps) {
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const api = useApi()

  // Track if initialization has started to prevent double-init in StrictMode
  const initStartedRef = useRef(false)

  // Initialize session on mount
  useEffect(() => {
    if (initStartedRef.current) {
      return
    }
    initStartedRef.current = true

    const initSession = async () => {
      try {
        await api.invoke('session:create', { workingDir: '.' })
        setIsReady(true)
      } catch (err) {
        console.error('[IpcSessionContext] Session initialization failed:', err)
        setError(err instanceof Error ? err : new Error(String(err)))
        setIsReady(true)
      }
    }

    initSession()
  }, [api])

  // Reset the session to its initial environment state
  const resetSession = useCallback(async (): Promise<void> => {
    try {
      await api.invoke('session:reset')
      console.log('[IpcSessionContext] Session reset successfully')
    } catch (err) {
      console.error('[IpcSessionContext] Failed to reset session:', err)
      throw err
    }
  }, [api])

  // Provide both IpcSessionContext and SessionContext so useSession() keeps working.
  // getAuthHeader returns an empty object because IPC is process-local.
  const legacyValue = { isReady, resetSession, error, getAuthHeader: () => ({}) as Record<string, never> }

  return (
    <SessionContext.Provider value={legacyValue}>
      <IpcSessionContext.Provider value={{ isReady, resetSession, error }}>
        {children}
      </IpcSessionContext.Provider>
    </SessionContext.Provider>
  )
}
