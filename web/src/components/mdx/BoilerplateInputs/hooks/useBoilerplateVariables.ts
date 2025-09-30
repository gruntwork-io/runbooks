import { useState, useEffect, useRef } from 'react'
import type { BoilerplateConfig } from '../BoilerplateInputs.types'
import type { AppError } from '../../../../types/error'

interface UseBoilerplateConfigResult {
  config: BoilerplateConfig | null
  loading: boolean
  error: AppError | null
}

/**
 * Custom hook for loading boilerplate variables from a boilerplate.yml file.
 * 
 * This hook fetches and parses a boilerplate.yml file either from a specified template directory
 * or from provided boilerplate content, providing the variable definitions needed to render 
 * dynamic forms. It handles loading states, error handling, and provides fallback mechanisms 
 * for API connectivity.
 * 
 * @param options - Configuration object containing either templatePath or boilerplateContent
 * @param options.templatePath - The path to the boilerplate template directory containing boilerplate.yml
 * @param options.boilerplateContent - The direct content of the boilerplate.yml file
 * @returns An object containing:
 *   - config: The parsed boilerplate variables configuration, or null if not loaded/available
 *   - loading: Boolean indicating if the variables are currently being loaded
 *   - error: AppError object if loading failed, or null if successful
 * 
 * @example
 * ```tsx
 * // Using template path
 * const { config, loading, error } = useBoilerplateVariables({ templatePath: 'terraform-boilerplate' })
 * 
 * // Using direct content
 * const { config, loading, error } = useBoilerplateVariables({ 
 *   boilerplateContent: 'variables:\n  - name: AccountName\n    type: string' 
 * })
 * 
 * if (loading) return <div>Loading...</div>
 * if (error) return <div>Error: {error.message}</div>
 * if (config) return <Form config={config} />
 * ```
 * 
 * @remarks
 * - The hook automatically retries with a direct backend connection if the proxy fails
 * - Variables are cached and won't reload unless the inputs change
 * - The hook expects the backend API to be available at /api/boilerplate/variables
 * - Only one of templatePath or boilerplateContent should be provided, not both
 */
export const useBoilerplateVariables = (options?: { templatePath?: string; boilerplateYamlContent?: string }): UseBoilerplateConfigResult => {
  const [config, setConfig] = useState<BoilerplateConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<AppError | null>(null)
  const safeToLoad = useRef(true)

  useEffect(() => {
    // Validate input parameters
    if (!options || (!options.templatePath && !options.boilerplateYamlContent)) {
      setIsLoading(false)
      setError({
        message: 'No templatePath or boilerplateContent provided',
        details: 'Please provide either a templatePath to load from a file or boilerplateContent with the direct content'
      })
      return
    }

    // Ensure only one of templatePath or boilerplateContent is provided
    if (options.templatePath && options.boilerplateYamlContent) {
      setIsLoading(false)
      setError({
        message: 'Only one of templatePath or boilerplateContent should be provided, not both',
        details: 'Please provide either a templatePath to load from a file or boilerplateContent with the direct content, but not both'
      })
      return
    }

    if (!safeToLoad.current) {
      setIsLoading(false)
      return
    }

    const loadConfig = async () => {
      safeToLoad.current = false
      setIsLoading(true)
      setError(null)

      const apiUrl = `/api/boilerplate/variables`
      const requestBody = options.templatePath 
        ? { templatePath: options.templatePath }
        : { boilerplateContent: options.boilerplateYamlContent }
      
      try {
        console.log('here 1');
        let response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'same-origin',
          body: JSON.stringify(requestBody),
        })

        // Fallback to direct backend if proxy fails
        // TODO: Consider if we can remove this fallback since we handle proxying in the backend.
        if (!response.ok) {
          console.log('here 2');
          const directUrl = `http://localhost:7825/api/boilerplate/variables`
          response = await fetch(directUrl, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
            mode: 'cors',
            body: JSON.stringify(requestBody),
          })
        }

        console.log('here 3');

        if (!response.ok) {
          console.log('here 4');
          const errorData = await response.json().catch(() => ({}))
          setIsLoading(false)
          setError({
            message: errorData.error || `Failed to load boilerplate config: ${response.statusText}`,
            details: errorData.details || ''
          })
          console.log('here 5');
          return
        }

        const data = await response.json()
        setIsLoading(false)
        setConfig(data)
      } catch (fetchError) {
        setIsLoading(false)
        setError({
          message: 'Network error occurred while loading boilerplate configuration',
          details: fetchError instanceof Error ? fetchError.message : 'Unknown error'
        })
      } finally {
        setIsLoading(false)
      }
    }

    loadConfig()
  }, [options])

  return { config, loading: isLoading, error }
}
