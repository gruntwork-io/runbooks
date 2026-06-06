import { useCallback, useState, type ReactNode } from 'react'
import { useApi } from './ApiContext'
import { SessionContext } from './SessionContext.types'

interface IpcSessionProviderProps {
  children: ReactNode
}

/**
 * Manages session lifecycle via Electron IPC. IPC is process-local and
 * inherently trusted, so there is no Bearer token management.
 *
 * The session is created lazily in the main process the first time a runbook
 * is loaded (see runbook:get), using the runbook's parent directory as the
 * working dir. That way the session's workingDir is always meaningful for
 * scripts — we don't need a placeholder here.
 */
export function IpcSessionProvider({ children }: IpcSessionProviderProps) {
  const [isReady] = useState(true)
  const [error] = useState<Error | null>(null)
  const api = useApi()

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

  // Provide SessionContext so useSession() keeps working.
  // getAuthHeader returns an empty object because IPC is process-local.
  const legacyValue = { isReady, resetSession, error, getAuthHeader: () => ({}) as Record<string, never> }

  return <SessionContext.Provider value={legacyValue}>{children}</SessionContext.Provider>
}
