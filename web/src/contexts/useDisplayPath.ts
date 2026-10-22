import { useContext } from "react"
import { DisplayPathContext } from "./DisplayPathContext.types"

/**
 * A function that shortens the paths in a text for showing on screen:
 * `session/…` for the open session's directory, `~/…` for the home directory.
 * Show the full path on hover, and copy it in full.
 */
export function useDisplayPath(): (text: string) => string {
  return useContext(DisplayPathContext)
}
