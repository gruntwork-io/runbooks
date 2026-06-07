import { useContext } from 'react'
import { SessionContext, type SessionContextType } from './SessionContext.types'

/**
 * Hook to access the session context for persistent environment management.
 *
 * The session is established lazily in the Electron main process; consumers
 * gate work on `isReady` and can force a reset via `resetSession`.
 *
 * @example
 * const { isReady } = useSession()
 * if (!isReady) return null
 */
export function useSession(): SessionContextType {
  const context = useContext(SessionContext)
  
  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  
  return context
}
