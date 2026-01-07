import { useContext } from 'react'
import { SessionContext, type SessionContextType } from './SessionContext.types'

/**
 * Hook to access the session context for persistent environment management.
 * 
 * @example
 * const { isReady, getAuthHeader } = useSession()
 * 
 * // Use in API calls
 * const response = await fetch('/api/exec', {
 *   method: 'POST',
 *   headers: {
 *     'Content-Type': 'application/json',
 *     ...getAuthHeader(),
 *   },
 *   body: JSON.stringify({ ... }),
 * })
 */
export function useSession(): SessionContextType {
  const context = useContext(SessionContext)
  
  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  
  return context
}
