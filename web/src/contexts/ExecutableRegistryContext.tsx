import { useEffect, useState, type ReactNode } from 'react'
import { createAppError } from '@/types/error'
import type { AppError } from '@/types/error'
import { type Executable, type ExecutableRegistry, type ExecutableRegistryResponse } from '@/types/executable'
import { ExecutableRegistryContext, type ExecutableRegistryContextValue } from './ExecutableRegistryContext.types'

interface ExecutableRegistryProviderProps {
  children: ReactNode
}

export function ExecutableRegistryProvider({ children }: ExecutableRegistryProviderProps) {
  const [registry, setRegistry] = useState<ExecutableRegistry | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AppError | null>(null)
  const [useExecutableRegistry, setUseExecutableRegistry] = useState(true)

  // Check if the backend server is reachable
  const checkBackendHealth = async (): Promise<boolean> => {
    try {
      const response = await fetch('/api/health')
      return response.ok
    } catch {
      return false
    }
  }

  const fetchRegistry = async () => {
    setLoading(true)
    setError(null)

    // First, check if the backend is reachable
    const isBackendHealthy = await checkBackendHealth()
    if (!isBackendHealthy) {
      setError(createAppError(
        'Cannot connect to backend server',
        'The Runbooks backend server is not responding. It may not be running or may have crashed.'
      ))
      setLoading(false)
      return
    }

    // Backend is healthy, now fetch the registry
    try {
      const response = await fetch('/api/runbook/executables')
      
      if (!response.ok) {
        throw new Error(`Failed to fetch executable registry: ${response.status}`)
      }

      const data: ExecutableRegistryResponse = await response.json()
      setRegistry(data.executables)
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
  }

  useEffect(() => {
    const fetchRunbookInfo = async () => {
      try {
        const response = await fetch('/api/runbook')
        if (response.ok) {
          const data = await response.json()
          setUseExecutableRegistry(data.useExecutableRegistry ?? true)
        }
      } catch {
        // If we can't determine the server's mode, assume registry mode as the safe default
        // (open/serve/watch all use registry mode by default)
        setUseExecutableRegistry(true)
      }
    }
    fetchRunbookInfo()
  }, [])

  useEffect(() => {
    if (useExecutableRegistry) {
      fetchRegistry()
    } else {
      // Skip registry loading in live reload mode
      setLoading(false)
    }
  }, [useExecutableRegistry])

  const getExecutableByComponentId = (componentId: string): Executable | null => {
    if (!registry) return null

    // Find executable by component_id
    for (const executableId in registry) {
      const executable = registry[executableId]
      if (executable && executable.component_id === componentId) {
        return executable
      }
    }

    return null
  }

  // Show error state if registry fails to load
  if (error) {
    const isConnectionError = error.message === 'Cannot connect to backend server'
    
    return (
      <div className="p-8 text-center bg-red-50 border-2 border-red-600 m-8 rounded-lg w-2xl mx-auto">
        <h2 className="text-red-600 text-2xl font-semibold mb-3">{error.message}</h2>
        <p className="text-lg mb-2">{error.details}</p>
        {isConnectionError ? (
          <div className="text-gray-600 text-sm mt-4 w-xl text-center mx-auto space-y-2">
            <p>The Runbooks backend server needs to be running for this page to work.</p>
            <p>Start it with one of these commands:</p>
            <code className="block bg-gray-100 p-2 rounded mt-2 font-mono text-sm">
              runbooks open /path/to/your-runbook
            </code>
            <code className="block bg-gray-100 p-2 rounded font-mono text-sm">
              runbooks watch /path/to/your-runbook
            </code>
            <code className="block bg-gray-100 p-2 rounded font-mono text-sm">
              runbooks serve /path/to/your-runbook
            </code>
          </div>
        ) : (
          <p className="text-gray-600 text-sm mt-2 w-xl text-center mx-auto">
            The executable registry is a list of all the "executables" like files, scripts, or commands in the runbook. We use the executable registry so that only Runbook-authored execuables are actually executed, not arbitrary scripts. The Executable Registry loads at runtime, but it looks like we hit an error trying to do that.
          </p>
        )}
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
