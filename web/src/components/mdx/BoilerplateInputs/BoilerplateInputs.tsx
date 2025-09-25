import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { BoilerplateConfig, BoilerplateInputsProps } from './BoilerplateInputs.types'
import { BoilerplateInputsForm } from './BoilerplateInputsForm'

export const BoilerplateInputs: React.FC<BoilerplateInputsProps> = ({
  id,
  path,
  variables: prefilledVariables = {},
  onGenerate,
  children
}) => {
  // Declare state variables
  const [boilerplateConfig, setBoilerplateConfig] = useState<BoilerplateConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  
  // Prevent concurrent loads of the same boilerplate config
  const safeToLoad = useRef(true)

  // Memoize prefilledVariables to prevent unnecessary re-renders
  const memoizedPrefilledVariables = useCallback(() => prefilledVariables, [prefilledVariables])

  // Load boilerplate configuration
  useEffect(() => {
    // Prevent multiple loads for the same path
    if (!safeToLoad.current) {
      return
    }

    const loadBoilerplateConfig = async () => {
      // Validate ID prop first
      if (!id) {
        setError('The BoilerplateInputs component requires a non-empty "id" prop.')
        setErrorDetails('Please provide a unique "id" for this component instance.')
        return
      }

      // Validate that we have either path to a boilerplate.yml file or inline boilerplate.yml content
      if (!path && !children) {
        setError('No boilerplate.yml path was provided.')
        setErrorDetails('Please run the Runbooks binary with a path to a boilerplate.yml file.')
        return
      }
      else if (children) {
        // TODO: Implement inline YAML parsing in the frontend
        setError('Inline boilerplate.yml parsing not yet implemented')
        setErrorDetails('Please provide a "path" to a boilerplate.yml file instead of inline content.')
        return
      }

      // Looks like we're clear to call the backend API to parse the boilerplate.yml file
      safeToLoad.current = false
      setLoading(true)
      setError(null)
      setErrorDetails(null)
      
      // Translate the boilerplate.yml contents to a JSON object by calling our backend API
      const response = await fetch(`/api/boilerplate/variables?path=${encodeURIComponent(path!)}`)
      if (!response.ok) {
        // Try to parse the error response from the API
        let errorMessage = `Failed to load boilerplate config: ${response.statusText}`
        let errorDetailsMessage = null
        try {
          const errorData = await response.json()
          if (errorData.error) {
            errorMessage = errorData.error
          }
          if (errorData.details) {
            errorDetailsMessage = errorData.details
          }
        } catch (jsonError) {
            // Server returned non-JSON error response, use default message
            console.warn('Failed to parse error response as JSON:', jsonError)
        }
        setError(errorMessage)
        setErrorDetails(errorDetailsMessage)
        setLoading(false)
        return
      }
      
      const data = await response.json()
      setBoilerplateConfig(data)
      setLoading(false)
    }

    loadBoilerplateConfig()
  }, [id, path, memoizedPrefilledVariables, children])

  if (loading) {
    return (
      <div className="p-6 bg-gray-50 border border-gray-200 rounded-lg">
        <div className="text-center text-gray-600">Loading boilerplate configuration...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
        <div className="text-red-600 font-semibold mb-2">Error: {error}</div>
        {errorDetails && (
          <div className="text-red-600 text-sm">{errorDetails}</div>
        )}
      </div>
    )
  }

  if (!boilerplateConfig) {
    return (
      <div className="p-6 bg-gray-50 border border-gray-200 rounded-lg">
        <div className="text-center text-gray-600">Loading boilerplate configuration...</div>
      </div>
    )
  }

  return (
    <BoilerplateInputsForm
      id={id!}
      boilerplateConfig={boilerplateConfig}
      initialData={memoizedPrefilledVariables()}
      onSubmit={onGenerate}
    />
  )
}
