import { createContext } from 'react'

export interface SessionContextType {
  /** True once the session is established and ready for use */
  isReady: boolean
  /** Resets the session to its initial environment state */
  resetSession: () => Promise<void>
  /** Any error that occurred during session initialization */
  error: Error | null
}

export const SessionContext = createContext<SessionContextType | undefined>(undefined)
