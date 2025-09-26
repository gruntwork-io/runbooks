import { useState, useEffect, useRef } from 'react'
import type { BoilerplateConfig } from '../BoilerplateInputs.types'

interface UseBoilerplateConfigResult {
  config: BoilerplateConfig | null
  loading: boolean
  error: string | null
  errorDetails: string | null
}

/**
 * Custom hook for loading boilerplate variables from a boilerplate.yml file.
 * 
 * This hook fetches and parses a boilerplate.yml file from the specified template directory,
 * providing the variable definitions needed to render dynamic forms. It handles loading states,
 * error handling, and provides fallback mechanisms for API connectivity.
 * 
 * @param templatePath - The path to the boilerplate template directory containing boilerplate.yml
 * @returns An object containing:
 *   - config: The parsed boilerplate variables configuration, or null if not loaded/available
 *   - loading: Boolean indicating if the variables are currently being loaded
 *   - error: Error message string if loading failed, or null if successful
 *   - errorDetails: Additional error details for debugging, or null if no error
 * 
 * @example
 * ```tsx
 * const { config, loading, error, errorDetails } = useBoilerplateVariables('terraform-boilerplate')
 * 
 * if (loading) return <div>Loading...</div>
 * if (error) return <div>Error: {error}</div>
 * if (config) return <Form config={config} />
 * ```
 * 
 * @remarks
 * - The hook automatically retries with a direct backend connection if the proxy fails
 * - Variables are cached and won't reload unless the templatePath changes
 * - The hook expects the backend API to be available at /api/boilerplate/variables
 */
export const useBoilerplateVariables = (templatePath?: string): UseBoilerplateConfigResult => {
  const [config, setConfig] = useState<BoilerplateConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const safeToLoad = useRef(true)

  useEffect(() => {
    if (!templatePath || !safeToLoad.current) {
      return
    }

    const loadConfig = async () => {
      safeToLoad.current = false
      setLoading(true)
      setError(null)
      setErrorDetails(null)

      const apiUrl = `/api/boilerplate/variables?templatePath=${encodeURIComponent(templatePath)}`
      
      try {
        let response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'same-origin',
        })

        // Fallback to direct backend if proxy fails
        if (!response.ok) {
          const directUrl = `http://localhost:7825/api/boilerplate/variables?templatePath=${encodeURIComponent(templatePath)}`
          response = await fetch(directUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
            mode: 'cors',
          })
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          setError(errorData.error || `Failed to load boilerplate config: ${response.statusText}`)
          setErrorDetails(errorData.details || null)
          return
        }

        const data = await response.json()
        setConfig(data)
      } catch (fetchError) {
        setError('Network error occurred while loading boilerplate configuration')
        setErrorDetails(fetchError instanceof Error ? fetchError.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    loadConfig()
  }, [templatePath])

  return { config, loading, error, errorDetails }
}
