import { createContext } from "react"

/**
 * Shortens the paths in a text for showing on screen (see abbreviatePaths).
 * Outside a DisplayPathProvider it leaves the text as it is.
 */
export const DisplayPathContext = createContext<(text: string) => string>((text) => text)
