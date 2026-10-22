import { useCallback, type ReactNode } from "react"
import { DisplayPathContext } from "@/contexts/DisplayPathContext.types"
import { abbreviatePaths, type PathRoots } from "@/lib/displayPath"

/** Shortens the paths its children show against `roots`, as DisplayPathProvider does in the app. */
export function ShortenedPaths({ roots, children }: { roots: PathRoots; children: ReactNode }) {
  const shorten = useCallback((text: string) => abbreviatePaths(text, roots), [roots])
  return <DisplayPathContext.Provider value={shorten}>{children}</DisplayPathContext.Provider>
}
