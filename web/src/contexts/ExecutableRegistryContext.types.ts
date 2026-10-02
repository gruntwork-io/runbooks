import { createContext } from "react"
import { type Executable } from "@/types/executable"

export interface ExecutableRegistryContextValue {
  getExecutableByComponentId: (componentId: string) => Executable | null
  /**
   * Bumped each time the registry is re-read after the main process rebuilt
   * it (`registry:updated`). Blocks that show a script file re-read the file
   * when it changes, so the script they show is the one Run executes.
   */
  registryVersion: number
}

export const ExecutableRegistryContext = createContext<ExecutableRegistryContextValue | undefined>(
  undefined,
)
