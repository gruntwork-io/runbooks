import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useApi } from "./ApiContext"
import { SessionContext } from "./SessionContext.types"

interface IpcSessionProviderProps {
  children: ReactNode
}

/**
 * Manages session lifecycle via Electron IPC. IPC is process-local and
 * inherently trusted, so there is no Bearer token management.
 *
 * The session is created or resumed in the main process when a runbook is
 * loaded (see runbook:get), with a directory of its own as the working dir.
 * That way the session's workingDir is always meaningful for scripts — we
 * don't need a placeholder here.
 */
export function IpcSessionProvider({ children }: IpcSessionProviderProps) {
  const [isReady] = useState(true)
  const [error] = useState<Error | null>(null)
  const api = useApi()

  // Reset the session to its initial environment state
  const resetSession = useCallback(async (): Promise<void> => {
    try {
      await api.invoke("session:reset")
      console.log("[IpcSessionContext] Session reset successfully")
    } catch (err) {
      console.error("[IpcSessionContext] Failed to reset session:", err)
      throw err
    }
  }, [api])

  // Provide SessionContext so useSession() keeps working.
  const sessionValue = useMemo(
    () => ({ isReady, resetSession, error }),
    [isReady, resetSession, error],
  )

  return <SessionContext.Provider value={sessionValue}>{children}</SessionContext.Provider>
}
