import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useGetFile } from '@/hooks/useApiGetFile'
import { useBoilerplateVariables } from '@/contexts/useBoilerplateVariables'
import { useApiExec } from '@/hooks/useApiExec'
import { useExecutableRegistry } from '@/hooks/useExecutableRegistry'
import { extractInlineInputsId } from '../lib/extractInlineInputsId'
import { mergeBoilerplateVariables } from '../lib/mergeBoilerplateVariables'
import { extractTemplateVariables } from '@/components/mdx/BoilerplateTemplate/lib/extractTemplateVariables'
import type { ComponentType, ExecutionStatus } from '../types'
import type { AppError } from '@/types/error'
import { createAppError } from '@/types/error'

interface UseScriptExecutionProps {
  componentId: string
  path?: string
  command?: string
  /** Reference to one or more BoilerplateInputs by ID. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  boilerplateInputsId?: string | string[]
  children?: ReactNode
  componentType: ComponentType
}

interface UseScriptExecutionReturn {
  // Script content
  sourceCode: string
  language?: string
  
  // File loading
  fileError: AppError | null
  
  // Variables
  collectedVariables: Record<string, unknown>
  requiredVariables: string[]
  hasAllRequiredVariables: boolean
  inlineInputsId: string | null
  
  // Rendering
  isRendering: boolean
  renderError: AppError | null
  
  // Execution
  status: ExecutionStatus
  logs: string[]
  execError: AppError | null
  execute: () => void
  cancel: () => void
}

/**
 * Shared hook for script execution logic used by Check and Command components.
 * Handles file loading, variable collection, template rendering, and execution.
 */
export function useScriptExecution({
  componentId,
  path,
  command,
  boilerplateInputsId,
  children,
  componentType
}: UseScriptExecutionProps): UseScriptExecutionReturn {
  // Get executable registry to look up executable ID
  const { getExecutableByComponentId, useExecutableRegistry: execRegistryEnabled } = useExecutableRegistry()
  
  // Only load file content if path is provided (not for inline commands)
  const shouldFetchFile = !!path && !command
  const { data: fileData, error: getFileError } = useGetFile(path || '', shouldFetchFile)
  
  // Determine raw script content: command prop takes precedence over file path
  const rawScriptContent = command || fileData?.content || ''
  const language = fileData?.language
  
  // Get boilerplate variables context for variable collection
  const { variablesByInputsId } = useBoilerplateVariables()
  
  // Extract inline BoilerplateInputs ID from children if present
  const inlineInputsId = useMemo(() => extractInlineInputsId(children), [children])
  
  // Collect variables from all sources and merge (later IDs override earlier, inline overrides all)
  const collectedVariables = useMemo(() => {
    return mergeBoilerplateVariables(boilerplateInputsId, variablesByInputsId, inlineInputsId)
  }, [boilerplateInputsId, inlineInputsId, variablesByInputsId])
  
  // Extract template variables from script content
  const requiredVariables = useMemo(() => {
    return extractTemplateVariables(rawScriptContent)
  }, [rawScriptContent])
  
  // Check if we have all required variables
  const hasAllRequiredVariables = useMemo(() => {
    if (requiredVariables.length === 0) return true // No variables needed
    
    return requiredVariables.every(varName => {
      const value = collectedVariables[varName]
      return value !== undefined && value !== null && value !== ''
    })
  }, [requiredVariables, collectedVariables])
  
  // State for rendered script content
  const [renderedScript, setRenderedScript] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<AppError | null>(null)
  const [isRendering, setIsRendering] = useState(false)
  
  // Track last rendered variables to prevent duplicate renders
  const lastRenderedVariablesRef = useRef<string | null>(null)
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null)
  
  // Track if component is mounted to prevent setState on unmounted component
  const isMountedRef = useRef(true)
  
  // Track pending fetch to allow cancellation
  const abortControllerRef = useRef<AbortController | null>(null)
  
  // Determine the actual script content to use
  const sourceCode = renderedScript !== null ? renderedScript : rawScriptContent
  
  // Use the API exec hook for real script execution
  const { state: execState, execute: executeScript, executeByComponentId, cancel: cancelExec } = useApiExec()
  
  // Map exec state to our status type, handling warn status for Check components
  // Note: componentType never changes, so we can directly check without memoization
  const status: ExecutionStatus = 
    execState.status === 'warn' && componentType === 'command' 
      ? 'fail' 
      : execState.status as ExecutionStatus
  
  const logs = execState.logs
  const execError = execState.error

  // Function to render script with variables
  const renderScript = useCallback(async (variables: Record<string, unknown>) => {
    // Cancel any pending render request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    
    // Create new abort controller for this request
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    
    setIsRendering(true)
    setRenderError(null)
    
    // Build template files object with just the script content
    // For Command/Check, we only need simple variable substitution - we don't need the full
    // boilerplate.yml config (which may include dependencies that aren't relevant here).
    // We just need to render {{ .VarName }} templates with the variable values.
    const templateFiles: Record<string, string> = {
      // 'script.sh' is just a filename identifier for the API request/response
      // Each API call is isolated, so no risk of collision between components
      'script.sh': rawScriptContent,
      // Minimal boilerplate config - no variables or dependencies needed since
      // we're just doing template substitution with externally-provided values
      'boilerplate.yml': 'variables: []'
    }
    
    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateFiles,
          variables
        }),
        signal: abortController.signal
      })

      // Check if component is still mounted before updating state
      if (!isMountedRef.current) return

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        const errorMessage = errorData?.error || 'Failed to render script'
        setRenderError(createAppError(errorMessage, errorData?.details))
        setIsRendering(false)
        return
      }

      const responseData = await response.json()
      const renderedFiles = responseData.renderedFiles
      
      // Check if we got the expected file structure
      if (!renderedFiles || !renderedFiles['script.sh']) {
        setRenderError(createAppError(
          'Render response missing expected file',
          'The API did not return the rendered script.sh file'
        ))
        setIsRendering(false)
        return
      }
      
      setRenderedScript(renderedFiles['script.sh'].content)
      setIsRendering(false)
    } catch (err) {
      // Check if component is still mounted before updating state
      if (!isMountedRef.current) return
      
      // Don't set error if request was aborted (expected behavior)
      if (err instanceof Error && err.name === 'AbortError') {
        return
      }
      
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      setRenderError(createAppError(errorMessage, 'Failed to render script with variables'))
      setIsRendering(false)
    }
  }, [rawScriptContent])
  
  // Auto-update when variables change (debounced)
  useEffect(() => {
    // Only render if we have template variables and all required variables are available
    if (requiredVariables.length === 0) {
      // No template variables, use raw script
      setRenderedScript(null)
      return
    }
    
    if (!hasAllRequiredVariables) {
      // Required variables not available yet
      return
    }
    
    // Check if variables actually changed
    const variablesKey = JSON.stringify(collectedVariables)
    if (variablesKey === lastRenderedVariablesRef.current) {
      return
    }
    
    // Clear existing timer (handles cleanup when dependencies change)
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current)
    }
    
    // Capture current variables in closure to avoid race condition
    const variablesToRender = collectedVariables
    const keyToStore = variablesKey
    
    // Debounce: wait 300ms after last change before rendering
    autoUpdateTimerRef.current = setTimeout(() => {
      lastRenderedVariablesRef.current = keyToStore
      renderScript(variablesToRender)
    }, 300)
    
    // Cleanup: clear timer when effect re-runs or on unmount
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current)
      }
    }
  }, [collectedVariables, requiredVariables.length, hasAllRequiredVariables, renderScript])

  // Handle starting execution
  const execute = useCallback(() => {
    // Convert collected variables to strings (boilerplate expects string values)
    const stringVariables: Record<string, string> = {}
    for (const [key, value] of Object.entries(collectedVariables)) {
      stringVariables[key] = String(value)
    }
    
    if (execRegistryEnabled) {
      // Registry mode: Look up executable in registry and use executable ID
      const executable = getExecutableByComponentId(componentId)
      
      if (!executable) {
        console.error(`Executable not found for component ID: ${componentId}`)
        return
      }
      
      executeScript(executable.id, stringVariables)
    } else {
      // Live reload mode: Send component ID directly
      executeByComponentId(componentId, stringVariables)
    }
  }, [execRegistryEnabled, executeScript, executeByComponentId, componentId, getExecutableByComponentId, collectedVariables])

  // Cleanup on unmount: cancel all pending operations
  useEffect(() => {
    isMountedRef.current = true
    
    return () => {
      isMountedRef.current = false
      
      // Cancel any pending render request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      
      // Cancel any ongoing execution
      cancelExec()
    }
  }, [cancelExec])

  return {
    // Script content
    sourceCode,
    language,
    
    // File loading
    fileError: getFileError,
    
    // Variables
    collectedVariables,
    requiredVariables,
    hasAllRequiredVariables,
    inlineInputsId,
    
    // Rendering
    isRendering,
    renderError,
    
    // Execution
    status,
    logs,
    execError,
    execute,
    cancel: cancelExec,
  }
}

