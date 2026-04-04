import { createContext } from 'react'

export interface IpcSessionContextType {
  /** True once the session is established and ready for use */
  isReady: boolean
  /** Resets the session to its initial environment state */
  resetSession: () => Promise<void>
  /** Any error that occurred during session initialization */
  error: Error | null
}

export const IpcSessionContext = createContext<IpcSessionContextType | undefined>(undefined)
