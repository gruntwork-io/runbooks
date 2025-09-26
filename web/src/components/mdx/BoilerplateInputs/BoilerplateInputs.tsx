import React, { useState, useEffect, useRef, useCallback } from 'react'
import type { BoilerplateConfig, BoilerplateInputsProps } from './BoilerplateInputs.types'
import { BoilerplateInputsForm } from './BoilerplateInputsForm'

/**
 * BoilerplateInputs component for rendering dynamic forms based on boilerplate.yml configuration.
 * 
 * This component loads a boilerplate configuration from a specified template path, renders a form
 * based on the variable definitions in the boilerplate.yml file, and allows users to generate
 * files by providing values for those variables. The component handles the entire workflow from
 * configuration loading to file generation via API calls.
 * 
 * @param props - The component props
 * @param props.id - Unique identifier for this component instance (required)
 * @param props.templatePath - Path to the boilerplate template directory, relative to the runbook file
 * @param props.variables - Pre-filled variable values to populate the form with
 * @param props.onGenerate - Optional callback function called when files are successfully generated
 * @param props.children - Inline boilerplate.yml content (not yet implemented)
 * 
 * @example
 * ```tsx
 * <BoilerplateInputs
 *   id="terraform-setup"
 *   templatePath="terraform-boilerplate"
 *   variables={{ environment: "dev", region: "us-west-2" }}
 *   onGenerate={(vars) => console.log('Generated with:', vars)}
 * />
 * ```
 */
export const BoilerplateInputs: React.FC<BoilerplateInputsProps> = ({
  id,
  templatePath, 
  variables: prefilledVariables = {},
  onGenerate,
  children
}) => {
  // Declare state variables
  const [boilerplateConfig, setBoilerplateConfig] = useState<BoilerplateConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generateSuccess, setGenerateSuccess] = useState<string | null>(null)
  
  // Prevent concurrent loads of the same boilerplate config
  const safeToLoad = useRef(true)

  // Memoize prefilledVariables to prevent unnecessary re-renders
  const memoizedPrefilledVariables = useCallback(() => prefilledVariables, [prefilledVariables])

  // Handle the user clicking the "generate' button by calling the render API to render the boilerplate template
  const handleGenerate = async (variables: Record<string, unknown>) => {
    if (!templatePath) {
      setError('No boilerplate template path available for rendering')
      setErrorDetails('Cannot generate files without a valid path to a boilerplate template')
      return
    }

    // Debug logging
    console.log('BoilerplateInputs handleGenerate called with:', {
      templatePath: templatePath,
      variables: variables
    })

    setIsGenerating(true)
    setError(null)
    setErrorDetails(null)
    setGenerateSuccess(null)

    try {
      // Use templatePath directly as the template directory
      const templateDir = templatePath

      // Debug logging
      console.log('BoilerplateInputs handleGenerate:', {
        templatePath: templatePath,
        templateDir: templateDir,
        variables: variables
      })

      const response = await fetch('/api/boilerplate/render', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templatePath: templateDir,
          variables: variables,
          // No outputPath provided - will use default "generated" directory
          // TODO: Add support for outputPath parameter so user can specify a different output directory
        }),
      })

      if (!response.ok) {
        let errorMessage = `Failed to generate files: ${response.statusText}`
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
          console.warn('Failed to parse error response as JSON:', jsonError)
        }
        setError(errorMessage)
        setErrorDetails(errorDetailsMessage)
        return
      }

      const data = await response.json()
      setGenerateSuccess(`Files generated successfully in: ${data.outputDir}`)
      
      // Call the optional onGenerate callback if provided
      if (onGenerate) {
        onGenerate(variables)
      }
    } catch (fetchError) {
      setError('Network error occurred while generating files')
      setErrorDetails(fetchError instanceof Error ? fetchError.message : 'Unknown error')
    } finally {
      setIsGenerating(false)
    }
  }

  // Load the boilerplate configuration so we can render the form based on a boilerplate.yml file
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

      // Validate that we have either templatePath or inline boilerplate.yml content
      if (!templatePath && !children) {
        setError('No template path was provided.')
        setErrorDetails('Please provide a templatePath to the boilerplate template directory.')
        return
      }
      else if (children) {
        // TODO: Implement inline YAML parsing in the frontend
        setError('Inline boilerplate.yml parsing not yet implemented')
        setErrorDetails('Please provide a "templatePath" to a boilerplate template directory instead of inline content.')
        return
      }

      // Looks like we're clear to call the backend API to parse the boilerplate.yml file
      safeToLoad.current = false
      setLoading(true)
      setError(null)
      setErrorDetails(null)
      
      // Translate the boilerplate.yml contents to a JSON object by calling our backend API
      // The API expects the templatePath to be a directory, and it will append "boilerplate.yml" itself
      const apiUrl = `/api/boilerplate/variables?templatePath=${encodeURIComponent(templatePath)}`
      
      console.log('BoilerplateInputs: Making API request to:', apiUrl)
      
      let response
      try {
        response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'same-origin', // Ensure cookies are sent
        })
      } catch (proxyError) {
        console.warn('BoilerplateInputs: Proxy request failed, trying direct backend:', proxyError)
        // Fallback: try direct backend connection
        const directUrl = `http://localhost:7825/api/boilerplate/variables?templatePath=${encodeURIComponent(templatePath)}`
        console.log('BoilerplateInputs: Trying direct backend request to:', directUrl)
        
        response = await fetch(directUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          mode: 'cors', // Enable CORS for direct backend access
        })
      }
      
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
      
      try {
        const data = await response.json()
        console.log('BoilerplateInputs: Successfully loaded config:', data)
        setBoilerplateConfig(data)
        setLoading(false)
      } catch (fetchError) {
        console.error('BoilerplateInputs: Fetch error:', fetchError)
        setError('Network error occurred while loading boilerplate configuration')
        setErrorDetails(fetchError instanceof Error ? fetchError.message : 'Unknown error')
        setLoading(false)
      }
    }

    loadBoilerplateConfig()
  }, [id, templatePath, memoizedPrefilledVariables, children])

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

  if (generateSuccess) {
    return (
      <div className="p-6 bg-green-50 border border-green-200 rounded-lg">
        <div className="text-green-600 font-semibold mb-2">Success!</div>
        <div className="text-green-600 text-sm">{generateSuccess}</div>
        <button
          onClick={() => {
            setGenerateSuccess(null)
            setError(null)
            setErrorDetails(null)
          }}
          className="mt-3 px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition-colors"
        >
          Generate Again
        </button>
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
      onSubmit={handleGenerate}
      isGenerating={isGenerating}
    />
  )
}
