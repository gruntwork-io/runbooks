import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useApi } from "./ApiContext"
import { DisplayPathContext } from "./DisplayPathContext.types"
import { abbreviatePaths } from "@/lib/displayPath"

interface DisplayPathProviderProps {
  /** The open session's own directory, if a runbook is open */
  sessionDir: string | undefined
  children: ReactNode
}

/**
 * Lets its descendants shorten the paths they show: those in `sessionDir` to
 * `session/…`, and other ones in the user's home directory to `~/…`.
 */
export function DisplayPathProvider({ sessionDir, children }: DisplayPathProviderProps) {
  const api = useApi()
  const [homeDir, setHomeDir] = useState<string>()

  useEffect(() => {
    api
      .invoke("native:get-home-dir")
      .then((home) => setHomeDir(home.path))
      // Paths are then shown in full, which is still right.
      .catch(() => {})
  }, [api])

  const abbreviate = useCallback(
    (text: string) => abbreviatePaths(text, { sessionDir, homeDir }),
    [sessionDir, homeDir],
  )
  return <DisplayPathContext.Provider value={abbreviate}>{children}</DisplayPathContext.Provider>
}
