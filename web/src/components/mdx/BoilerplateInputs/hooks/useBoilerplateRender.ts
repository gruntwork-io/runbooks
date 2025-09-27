import { useState, useRef, useCallback } from 'react'
import { useFileTree } from '../../../../hooks/useFileTree'

/**
 * Result object returned by the useBoilerplateRender hook
 */
interface UseBoilerplateRenderResult {
  /** Whether a boilerplate generation request is currently in progress */
  isGenerating: boolean
  /** Whether an auto-render (re-render boilerplate template based on updated form data) is currently in progress */
  isAutoRendering: boolean
  /** Success message when files are generated successfully, null otherwise */
  success: string | null
  /** Whether to show temporary success indicator */
  showSuccessIndicator: boolean
  /** Error message if generation fails, null otherwise */
  error: string | null
  /** Additional error details if generation fails, null otherwise */
  errorDetails: string | null
  /** Function to generate boilerplate files with the given template path and variables */
  generate: (templatePath: string, variables: Record<string, unknown>) => Promise<void>
  /** Function to re-render with debouncing (for real-time updates) */
  autoRender: (templatePath: string, variables: Record<string, unknown>) => void
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
  const [isAutoRendering, setIsAutoRendering] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [showSuccessIndicator, setShowSuccessIndicator] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const { setFileTree: setGlobalFileTree } = useFileTree()
  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const autoRenderTimeoutRef = useRef<NodeJS.Timeout | null>(null)

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
    setShowSuccessIndicator(false)
    setGlobalFileTree(null)

    // Clear any existing timeout
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current)
      successTimeoutRef.current = null
    }

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
      setShowSuccessIndicator(true)
      
      // Store the file tree data in the global context
      if (data.fileTree && Array.isArray(data.fileTree)) {
        setGlobalFileTree(data.fileTree)
      }
      
      // Auto-hide success indicator after 3 seconds
      successTimeoutRef.current = setTimeout(() => {
        setShowSuccessIndicator(false)
        successTimeoutRef.current = null
      }, 3000)
    } catch (fetchError) {
      setError('Network error occurred while generating files')
      setErrorDetails(fetchError instanceof Error ? fetchError.message : 'Unknown error')
    } finally {
      setIsGenerating(false)
    }
  }

  /**
   * Instantly re-renders boilerplate files for real-time updates.
   * 
   * This function provides immediate rendering that triggers instantly when called,
   * updating the file tree and UI state in real-time. Unlike the main render function,
   * this version doesn't clear success messages or file tree data, making it ideal
   * for auto-updates as users modify form inputs.
   * 
   * @param {string} templatePath - Path to the boilerplate template directory
   * @param {Record<string, unknown>} variables - Key-value pairs of variables to substitute in the template
   * @returns {void}
   * 
   * @example
   * ```tsx
   * // Auto-render when form changes (instant)
   * autoRender('terraform-template', { environment: 'dev', region: 'us-west-2' })
   * ```
   */
  const autoRender = useCallback(async (templatePath: string, variables: Record<string, unknown>) => {
    // Clear any existing re-render timeout
    if (autoRenderTimeoutRef.current) {
      clearTimeout(autoRenderTimeoutRef.current)
      autoRenderTimeoutRef.current = null
    }

    // Instant re-render (no delay)
    setIsAutoRendering(true)
    setError(null)
    setErrorDetails(null)
    // Don't clear success message for re-renders
    // Don't clear file tree for re-renders

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
        setError(errorData.error || `Failed to auto-render files: ${response.statusText}`)
        setErrorDetails(errorData.details || null)
        return
      }

      const data = await response.json()
      
      // Update the file tree data in the global context (only if successful)
      if (data.fileTree && Array.isArray(data.fileTree)) {
        setGlobalFileTree(data.fileTree)
      }
      
      // Clear any previous errors on successful auto-render
      setError(null)
      setErrorDetails(null)
    } catch (fetchError) {
      setError('Network error occurred while auto-rendering files')
      setErrorDetails(fetchError instanceof Error ? fetchError.message : 'Unknown error')
    } finally {
      setIsAutoRendering(false)
    }
  }, [setGlobalFileTree])

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
    setShowSuccessIndicator(false)
    setError(null)
    setErrorDetails(null)
    setGlobalFileTree(null)
    
    // Clear any existing timeouts
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current)
      successTimeoutRef.current = null
    }
    if (autoRenderTimeoutRef.current) {
      clearTimeout(autoRenderTimeoutRef.current)
      autoRenderTimeoutRef.current = null
    }
  }

  return { isGenerating, isAutoRendering, success, showSuccessIndicator, error, errorDetails, generate, autoRender: autoRender, reset }
}
