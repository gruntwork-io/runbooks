import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { type Executable, type ExecutableRegistry } from '@/types/executable'
import { ExecutableRegistryContext, type ExecutableRegistryContextValue } from './ExecutableRegistryContext.types'
import { useApi } from './ApiContext'

interface IpcExecutableRegistryProviderProps {
  children: ReactNode
}

/**
 * Provides the executable registry for the current runbook via Electron IPC.
 * No health check is needed: the backend runs in the same process.
 */
export function IpcExecutableRegistryProvider({ children }: IpcExecutableRegistryProviderProps) {
  const [registry, setRegistry] = useState<ExecutableRegistry | null>(null)
  const api = useApi()

  const fetchRegistry = useCallback(async () => {
    try {
      const data = await api.invoke('runbook:executables')
      setRegistry(data.executables as unknown as ExecutableRegistry)
    } catch (err) {
      // runbook:executables only reads in-memory state, so this is an IPC
      // failure. Blocks report the missing executable when they're run.
      console.error('Failed to load executable registry:', err)
    }
  }, [api])

  // Fetch on mount, then again whenever the main process signals it has
  // rebuilt the registry (runbook:get on open and on watch-mode reloads).
  useEffect(() => {
    fetchRegistry()
    return api.on('registry:updated', () => {
      fetchRegistry()
    })
  }, [api, fetchRegistry])

  const getExecutableByComponentId = useCallback((componentId: string): Executable | null => {
    if (!registry) return null
    return Object.values(registry).find(e => e?.componentId === componentId) ?? null
  }, [registry])

  // Don't block rendering while the registry loads — it is populated
  // asynchronously after runbook:get completes and sends registry:updated.
  // Individual components handle the missing-executable case gracefully.

  const value = useMemo<ExecutableRegistryContextValue>(
    () => ({ getExecutableByComponentId }),
    [getExecutableByComponentId],
  )

  return (
    <ExecutableRegistryContext.Provider value={value}>
      {children}
    </ExecutableRegistryContext.Provider>
  )
}
