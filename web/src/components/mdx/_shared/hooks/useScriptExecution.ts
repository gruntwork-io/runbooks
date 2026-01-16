import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useGetFile } from '@/hooks/useApiGetFile'
import { useImportedVarValues } from '@/contexts/useBlockVariables'
import { useApiExec } from '@/hooks/useApiExec'
import type { FilesCapturedEvent, LogEntry } from '@/hooks/useApiExec'
import { useExecutableRegistry } from '@/hooks/useExecutableRegistry'
import { useFileTree } from '@/hooks/useFileTree'
import { useLogs } from '@/contexts/useLogs'
import { extractInlineInputsId } from '../lib/extractInlineInputsId'
import { extractTemplateVariables } from '@/components/mdx/TemplateInline/lib/extractTemplateVariables'
import { computeSha256Hash } from '@/lib/hash'
import type { ComponentType, ExecutionStatus } from '../types'
import type { AppError } from '@/types/error'
import { createAppError } from '@/types/error'

interface UseScriptExecutionProps {
  componentId: string
  path?: string
  command?: string
  /** Reference to one or more Inputs by ID for template variable substitution. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Reference to an AwsAuth block by ID for AWS credentials. */
  awsAuthId?: string
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
  importedVarValues: Record<string, unknown>
  requiredVariables: string[]
  hasAllRequiredVariables: boolean
  inlineInputsId: string | null
  
  // Rendering
  isRendering: boolean
  renderError: AppError | null
  
  // Execution
  status: ExecutionStatus
  logs: LogEntry[]
  execError: AppError | null
  execute: () => void
  cancel: () => void
  
  // Drift detection (script changed on disk since runbook was opened)
  hasScriptDrift: boolean
}

/**
 * Shared hook for script execution logic used by Check and Command components.
 * Handles file loading, variable collection, template rendering, and execution.
 */
export function useScriptExecution({
  componentId,
  path,
  command,
  inputsId,
  awsAuthId,
  children,
  componentType,
}: UseScriptExecutionProps): UseScriptExecutionReturn {
  // Get executable registry to look up executable ID
  const { getExecutableByComponentId, useExecutableRegistry: execRegistryEnabled } = useExecutableRegistry()
  
  // Get file tree context for updating when files are captured
  const { setFileTree } = useFileTree()
  
  // Get logs context for global log aggregation
  const { registerLogs } = useLogs()
  
  // Callback to handle files captured from command execution
  const handleFilesCaptured = useCallback((event: FilesCapturedEvent) => {
    // Update the file tree with the new tree from the backend
    // The fileTree is already validated by Zod in useApiExec
    setFileTree(event.fileTree)
  }, [setFileTree])
  
  // Only load file content if path is provided (not for inline commands)
  const shouldFetchFile = !!path && !command
  const { data: fileData, error: getFileError } = useGetFile(path || '', shouldFetchFile)
  
  // Determine raw script content: command prop takes precedence over file path
  const rawScriptContent = command || fileData?.content || ''
  const language = fileData?.language
  
  // State for computed hash of inline command content (for drift detection)
  // Store the command along with its hash to avoid race conditions when command prop changes
  const [commandHashResult, setCommandHashResult] = useState<{ command: string; hash: string } | null>(null)
  
  // Compute hash of inline command content when it changes
  useEffect(() => {
    if (!command) {
      setCommandHashResult(null)
      return
    }
    
    // Track if this effect instance is still active (handles unmount and re-runs)
    let isActive = true
    computeSha256Hash(command).then(hash => {
      if (isActive) {
        setCommandHashResult({ command, hash })
      }
    })
    
    return () => {
      isActive = false
    }
  }, [command])
  
  // Detect script drift: when the current content differs from what's registered
  // This applies in registry mode for both file-based scripts AND inline commands
  const hasScriptDrift = useMemo(() => {
    // No drift detection needed in live reload mode (scripts are always fresh)
    if (!execRegistryEnabled) return false
    
    const executable = getExecutableByComponentId(componentId)
    if (!executable?.script_content_hash) return false
    
    // For inline commands, compare computed hash against registry hash
    if (command) {
      // If the hash we have is not for the current command, we can't know the drift status yet.
      // Returning false is a safe default until the new hash is computed.
      if (commandHashResult?.command !== command) {
        return false
      }
      return commandHashResult.hash !== executable.script_content_hash
    }
    
    // For file-based scripts, compare file hash against registry hash
    if (!fileData?.contentHash) return false
    return fileData.contentHash !== executable.script_content_hash
  }, [execRegistryEnabled, command, commandHashResult, fileData?.contentHash, componentId, getExecutableByComponentId])
  
  // Extract inline Inputs ID from children if present
  const inlineInputsId = useMemo(() => extractInlineInputsId(children), [children])
  
  // Build the list of inputsIds for template variables (inline has highest precedence, so it goes last)
  const templateInputsIds = useMemo(() => {
    const ids: string[] = []
    
    // Add external inputsId(s) first
    if (inputsId) {
      if (Array.isArray(inputsId)) {
        ids.push(...inputsId)
      } else {
        ids.push(inputsId)
      }
    }
    
    // Add inline inputsId last (highest precedence)
    if (inlineInputsId) {
      ids.push(inlineInputsId)
    }
    
    return ids
  }, [inputsId, inlineInputsId])
  
  // Get template variables from BlockVariablesContext (for {{ .VarName }} substitution)
  const importedVarValues = useImportedVarValues(templateInputsIds.length > 0 ? templateInputsIds : undefined)
  
  // Get AWS auth variables separately (for environment variable injection)
  const awsAuthVarValues = useImportedVarValues(awsAuthId)
  
  // Build combined list for checking if any inputs are configured
  const allInputsIds = useMemo(() => {
    const ids = [...templateInputsIds]
    if (awsAuthId) ids.push(awsAuthId)
    return ids
  }, [templateInputsIds, awsAuthId])
  
  // Extract template variables from script content
  const requiredVariables = useMemo(() => {
    return extractTemplateVariables(rawScriptContent)
  }, [rawScriptContent])
  
  // Check if we have all required variables
  const hasAllRequiredVariables = useMemo(() => {
    if (requiredVariables.length === 0) return true // No variables needed
    
    return requiredVariables.every(varName => {
      const value = importedVarValues[varName]
      return value !== undefined && value !== null && value !== ''
    })
  }, [requiredVariables, importedVarValues])
  
  // State for rendered script content
  const [renderedScript, setRenderedScript] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<AppError | null>(null)
  const [isRendering, setIsRendering] = useState(false)
  
  // State for registry errors (when executable not found)
  const [registryError, setRegistryError] = useState<AppError | null>(null)
  
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
  // Pass onFilesCaptured callback to update file tree when scripts write to $RUNBOOKS_OUTPUT
  const { state: execState, execute: executeScript, executeByComponentId, cancel: cancelExec } = useApiExec({
    onFilesCaptured: handleFilesCaptured,
  })
  
  // Map exec state to our status type, handling warn status for Check components
  // Note: componentType never changes, so we can directly check without memoization
  const status: ExecutionStatus = 
    execState.status === 'warn' && componentType === 'command' 
      ? 'fail' 
      : execState.status as ExecutionStatus
  
  const logs = execState.logs
  const execError = execState.error
  
  // Register logs with global context whenever they change
  useEffect(() => {
    registerLogs(componentId, logs)
  }, [componentId, logs, registerLogs])

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
    const variablesKey = JSON.stringify(importedVarValues)
    if (variablesKey === lastRenderedVariablesRef.current) {
      return
    }
    
    // Clear existing timer (handles cleanup when dependencies change)
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current)
    }
    
    // Capture current variables in closure to avoid race condition
    const variablesToRender = importedVarValues
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
  }, [importedVarValues, requiredVariables.length, hasAllRequiredVariables, renderScript])

  // Handle starting execution
  const execute = useCallback(() => {
    // Clear any previous registry error
    setRegistryError(null)
    
    // Convert template variables to strings (for {{ .VarName }} substitution)
    const stringVariables: Record<string, string> = {}
    for (const [key, value] of Object.entries(importedVarValues)) {
      stringVariables[key] = String(value)
    }
    
    // Convert AWS auth variables to strings (for environment variable injection)
    const envVars: Record<string, string> = {}
    for (const [key, value] of Object.entries(awsAuthVarValues)) {
      envVars[key] = String(value)
    }
    
    if (execRegistryEnabled) {
      // Registry mode: Look up executable in registry and use executable ID
      const executable = getExecutableByComponentId(componentId)
      
      if (!executable) {
        // Show error to user instead of silently failing
        setRegistryError(createAppError(
          `Executable not found for component "${componentId}"`,
          'This means that Runbooks attempted to run a script or command that was not defined when Runbooks was first loaded. ' +
          'Common causes include changing a script before re-loading runbooks, or syntax errors in the command or script path. ' +
          'Try re-opening your runbook, or check the runbooks server logs for details.'
        ))
        return
      }
      
      executeScript(executable.id, stringVariables, envVars)
    } else {
      // Live reload mode: Send component ID directly
      executeByComponentId(componentId, stringVariables, envVars)
    }
  }, [execRegistryEnabled, executeScript, executeByComponentId, componentId, getExecutableByComponentId, importedVarValues, awsAuthVarValues])

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

  // Combine exec error and registry error - show registry error if present
  const combinedExecError = registryError || execError

  return {
    // Script content
    sourceCode,
    language,
    
    // File loading
    fileError: getFileError,
    
    // Variables
    importedVarValues,
    requiredVariables,
    hasAllRequiredVariables,
    inlineInputsId,
    
    // Rendering
    isRendering,
    renderError,
    
    // Execution
    status,
    logs,
    execError: combinedExecError,
    execute,
    cancel: cancelExec,
    
    // Drift detection
    hasScriptDrift,
  }
}

