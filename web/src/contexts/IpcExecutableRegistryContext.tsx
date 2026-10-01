import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { type Executable, type ExecutableRegistry } from "@/types/executable"
import {
  ExecutableRegistryContext,
  type ExecutableRegistryContextValue,
} from "./ExecutableRegistryContext.types"
import { useApi } from "./ApiContext"

interface IpcExecutableRegistryProviderProps {
  children: ReactNode
}

/**
 * Provides the executable registry for the current runbook via Electron IPC.
 * No health check is needed: the backend runs in the same process.
 */
export function IpcExecutableRegistryProvider({ children }: IpcExecutableRegistryProviderProps) {
  const [registry, setRegistry] = useState<ExecutableRegistry | null>(null)
  const [registryVersion, setRegistryVersion] = useState(0)
  const api = useApi()

  // Fetch on mount, then again whenever the main process signals it has
  // rebuilt the registry (runbook:get on open and on watch-mode reloads).
  useEffect(() => {
    const fetchRegistry = async (rebuilt: boolean) => {
      try {
        const data = await api.invoke("runbook:executables")
        setRegistry(data.executables as unknown as ExecutableRegistry)
        // Set with the registry, in the same render, so blocks re-read their
        // script files against the registry that will run them.
        if (rebuilt) setRegistryVersion((v) => v + 1)
      } catch (err) {
        // runbook:executables only reads in-memory state, so this is an IPC
        // failure. Blocks report the missing executable when they're run.
        console.error("Failed to load executable registry:", err)
      }
    }

    void fetchRegistry(false)
    return api.on("registry:updated", () => {
      void fetchRegistry(true)
    })
  }, [api])

  const getExecutableByComponentId = useCallback(
    (componentId: string): Executable | null => {
      if (!registry) return null
      return Object.values(registry).find((e) => e?.componentId === componentId) ?? null
    },
    [registry],
  )

  // Don't block rendering while the registry loads — it is populated
  // asynchronously after runbook:get completes and sends registry:updated.
  // Individual components handle the missing-executable case gracefully.

  const value = useMemo<ExecutableRegistryContextValue>(
    () => ({ getExecutableByComponentId, registryVersion }),
    [getExecutableByComponentId, registryVersion],
  )

  return (
    <ExecutableRegistryContext.Provider value={value}>
      {children}
    </ExecutableRegistryContext.Provider>
  )
}
