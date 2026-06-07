import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createAppError } from '@/types/error'
import type { AppError } from '@/types/error'
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
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AppError | null>(null)
  const [useExecutableRegistry, setUseExecutableRegistry] = useState(true)
  const api = useApi()

  const fetchRegistry = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true)
    }
    setError(null)

    try {
      const data = await api.invoke('runbook:executables')
      setRegistry(data.executables as unknown as ExecutableRegistry)
      setWarnings(data.warnings || [])
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(createAppError(
        'Failed to load executable registry',
        errorMessage
      ))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    const fetchRunbookInfo = async () => {
      try {
        const data = await api.invoke('runbook:get', { path: '' })
        setUseExecutableRegistry(data.useExecutableRegistry ?? true)
      } catch {
        // If we can't determine the mode, assume registry mode as the safe default
        setUseExecutableRegistry(true)
      }
    }
    fetchRunbookInfo()
  }, [api])

  useEffect(() => {
    if (useExecutableRegistry) {
      fetchRegistry()
    } else {
      // Skip registry loading in live reload mode
      setLoading(false)
    }
  }, [useExecutableRegistry, fetchRegistry])

  // Re-fetch registry when the main process signals it has been rebuilt.
  // Use silent mode to avoid blocking the UI (which would unmount App and
  // trigger an infinite remount loop).
  useEffect(() => {
    const cleanup = api.on('registry:updated', () => {
      if (useExecutableRegistry) {
        fetchRegistry(true)
      }
    })
    return cleanup
  }, [api, useExecutableRegistry, fetchRegistry])

  const getExecutableByComponentId = (componentId: string): Executable | null => {
    if (!registry) return null
    return Object.values(registry).find(e => e?.componentId === componentId) ?? null
  }

  // Don't block rendering while loading or on error — the registry is populated
  // asynchronously after runbook:get completes and sends registry:updated. Individual
  // components handle the missing-executable case gracefully.

  const value: ExecutableRegistryContextValue = {
    registry,
    warnings,
    loading,
    error,
    useExecutableRegistry,
    getExecutableByComponentId,
  }

  return (
    <ExecutableRegistryContext.Provider value={value}>
      {children}
    </ExecutableRegistryContext.Provider>
  )
}
