import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createAppError } from '@/types/error'
import type { AppError } from '@/types/error'
import { type Executable, type ExecutableRegistry, type ExecutableRegistryResponse } from '@/types/executable'
import { ExecutableRegistryContext, type ExecutableRegistryContextValue } from './ExecutableRegistryContext.types'
import { useApi } from './ApiContext'

interface IpcExecutableRegistryProviderProps {
  children: ReactNode
}

/**
 * Electron IPC version of ExecutableRegistryProvider.
 *
 * Key differences from the HTTP version:
 * - No health check — in Electron the backend is the same process, always reachable.
 * - Uses api.invoke('runbook:executables') instead of fetch('/api/runbook/executables').
 * - Uses api.invoke('runbook:get') instead of fetch('/api/runbook').
 * - Error UI omits "start backend server" instructions since Electron IS the backend.
 */
export function IpcExecutableRegistryProvider({ children }: IpcExecutableRegistryProviderProps) {
  const [registry, setRegistry] = useState<ExecutableRegistry | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AppError | null>(null)
  const [useExecutableRegistry, setUseExecutableRegistry] = useState(true)
  const api = useApi()

  const fetchRegistry = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const data: ExecutableRegistryResponse = await api.invoke('runbook:executables')
      setRegistry(data.executables)
      setWarnings(data.warnings || [])
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setError(createAppError(
        'Failed to load executable registry',
        errorMessage,
        undefined,
        'REGISTRY_FETCH_FAILED'
      ))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    const fetchRunbookInfo = async () => {
      try {
        const data = await api.invoke<{ useExecutableRegistry?: boolean }>('runbook:get')
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

  const getExecutableByComponentId = (componentId: string): Executable | null => {
    if (!registry) return null

    for (const executableId in registry) {
      const executable = registry[executableId]
      if (executable && executable.componentId === componentId) {
        return executable
      }
    }

    return null
  }

  // Show error state if registry fails to load
  if (error) {
    return (
      <div className="p-8 text-center bg-red-50 border-2 border-red-600 m-8 rounded-lg w-2xl mx-auto">
        <h2 className="text-red-600 text-2xl font-semibold mb-3">{error.message}</h2>
        <p className="text-lg mb-2">{error.details}</p>
        <p className="text-gray-600 text-sm mt-2 w-xl text-center mx-auto">
          The executable registry is a list of all the "executables" like files, scripts, or commands in the runbook. We use the executable registry so that only Runbook-authored executables are actually executed, not arbitrary scripts. The Executable Registry loads at runtime, but it looks like we hit an error trying to do that.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 px-6 py-3 text-base bg-red-600 text-white rounded cursor-pointer hover:bg-red-700 transition-colors"
        >
          Reload Page
        </button>
      </div>
    )
  }

  // Show loading state
  if (loading) {
    return (
      <div className="p-8 text-center text-gray-600">
        <p>Loading executable registry...</p>
      </div>
    )
  }

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
