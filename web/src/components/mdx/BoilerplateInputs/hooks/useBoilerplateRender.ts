import { useState } from 'react'

/**
 * Result object returned by the useBoilerplateRender hook
 */
interface UseBoilerplateRenderResult {
  /** Whether a boilerplate generation request is currently in progress */
  isGenerating: boolean
  /** Success message when files are generated successfully, null otherwise */
  success: string | null
  /** Error message if generation fails, null otherwise */
  error: string | null
  /** Additional error details if generation fails, null otherwise */
  errorDetails: string | null
  /** Function to generate boilerplate files with the given template path and variables */
  generate: (templatePath: string, variables: Record<string, unknown>) => Promise<void>
  /** Function to reset all state (clear success/error messages) */
  reset: () => void
}

/**
 * Custom hook for managing boilerplate file generation via API calls.
 * 
 * This hook provides state management and API interaction for rendering files from
 * boilerplate templates. It handles the entire workflow from making the API request
 * to managing loading states, success messages, and error handling.
 * 
 * @returns {UseBoilerplateRenderResult} Object containing state and functions for boilerplate generation
 * 
 * @example
 * ```tsx
 * const { isGenerating, success, error, generate, reset } = useBoilerplateRender()
 * 
 * const handleGenerate = async () => {
 *   await generate('my-template', { environment: 'dev', region: 'us-west-2' })
 * }
 * ```
 */
export const useBoilerplateRender = (): UseBoilerplateRenderResult => {
  const [isGenerating, setIsGenerating] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)

  /**
   * Generates boilerplate files using the specified template path and variables.
   * 
   * Makes a POST request to the boilerplate render API endpoint to generate files
   * from a template. Updates the hook's state to reflect loading, success, or error
   * conditions throughout the process.
   * 
   * @param {string} templatePath - Path to the boilerplate template directory
   * @param {Record<string, unknown>} variables - Key-value pairs of variables to substitute in the template
   * @returns {Promise<void>} Promise that resolves when the generation request completes
   * 
   * @example
   * ```tsx
   * await generate('terraform-template', { 
   *   environment: 'dev', 
   *   region: 'us-west-2',
   *   instanceType: 't3.micro'
   * })
   * ```
   */
  const generate = async (templatePath: string, variables: Record<string, unknown>) => {
    setIsGenerating(true)
    setError(null)
    setErrorDetails(null)
    setSuccess(null)

    try {
      const response = await fetch('/api/boilerplate/render', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templatePath,
          variables,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        setError(errorData.error || `Failed to generate files: ${response.statusText}`)
        setErrorDetails(errorData.details || null)
        return
      }

      const data = await response.json()
      setSuccess(`Files generated successfully in: ${data.outputDir}`)
    } catch (fetchError) {
      setError('Network error occurred while generating files')
      setErrorDetails(fetchError instanceof Error ? fetchError.message : 'Unknown error')
    } finally {
      setIsGenerating(false)
    }
  }

  /**
   * Resets all state to initial values, clearing any success or error messages.
   * 
   * This function clears the success message, error message, and error details,
   * effectively resetting the hook to its initial state. Useful for allowing
   * users to retry operations or start fresh after a previous attempt.
   * 
   * @returns {void}
   * 
   * @example
   * ```tsx
   * // Clear any previous success/error states
   * reset()
   * ```
   */
  const reset = () => {
    setSuccess(null)
    setError(null)
    setErrorDetails(null)
  }

  return { isGenerating, success, error, errorDetails, generate, reset }
}
