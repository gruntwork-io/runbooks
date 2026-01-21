import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useGetFile } from '@/hooks/useApiGetFile'
import { useInputs, useRunbookContext, useAllOutputs, inputsToValues, type InputValue } from '@/contexts/useRunbook'
import { useApiExec } from '@/hooks/useApiExec'
import type { FilesCapturedEvent, LogEntry } from '@/hooks/useApiExec'
import { useExecutableRegistry } from '@/hooks/useExecutableRegistry'
import { useFileTree } from '@/hooks/useFileTree'
import { useLogs } from '@/contexts/useLogs'
import { extractInlineInputsId } from '../lib/extractInlineInputsId'
import { extractTemplateVariables } from '@/components/mdx/TemplateInline/lib/extractTemplateVariables'
import { extractOutputDependenciesFromString, type OutputDependency, groupDependenciesByBlock } from '@/components/mdx/TemplateInline/lib/extractOutputDependencies'
import { computeSha256Hash } from '@/lib/hash'
import type { ComponentType, ExecutionStatus } from '../types'
import type { AppError } from '@/types/error'
import { createAppError } from '@/types/error'
import { BoilerplateVariableType } from '@/types/boilerplateVariable'

interface UseScriptExecutionProps {
  componentId: string
  path?: string
  command?: string
  /** Reference to one or more Inputs by ID. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Reference to an AwsAuth block by ID for AWS credentials. The credentials will be passed as environment variables for this execution only. */
  awsAuthId?: string
  children?: ReactNode
  componentType: ComponentType
}

/** Information about an unmet output dependency */
export interface UnmetOutputDependency {
  blockId: string
  outputNames: string[]
}

interface UseScriptExecutionReturn {
  // Script content
  sourceCode: string
  language?: string
  
  // File loading
  fileError: AppError | null
  
  // Variables
  inputValues: Record<string, unknown>
  inputDependencies: string[]
  hasAllInputDependencies: boolean
  inlineInputsId: string | null
  
  // Output dependencies
  outputDependencies: OutputDependency[]
  unmetOutputDependencies: UnmetOutputDependency[]
  hasAllOutputDependencies: boolean
  
  // Rendering
  isRendering: boolean
  renderError: AppError | null
  
  // Execution
  status: ExecutionStatus
  logs: LogEntry[]
  execError: AppError | null
  execute: () => void
  cancel: () => void
  
  // Block outputs (key-value pairs produced by script via $RUNBOOK_OUTPUT)
  outputs: Record<string, string> | null
  
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
  
  // Get runbook context for registering outputs and getting template variables
  const { registerOutputs, unregisterOutputs, getTemplateVariables } = useRunbookContext()
  
  // Callback to handle files captured from command execution
  const handleFilesCaptured = useCallback((event: FilesCapturedEvent) => {
    // Update the file tree with the new tree from the backend
    // The fileTree is already validated by Zod in useApiExec
    setFileTree(event.fileTree)
  }, [setFileTree])
  
  // Callback to handle outputs captured from script execution
  const handleOutputsCaptured = useCallback((outputValues: Record<string, string>) => {
    // Register outputs in the runbook context so other blocks can access them
    registerOutputs(componentId, outputValues)
  }, [componentId, registerOutputs])
  
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
  
  // Build the complete list of inputsIds to merge (inline has highest precedence, so it goes last)
  const allInputsIds = useMemo(() => {
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
  
  // Get inputs for API requests and derive values map for lookups
  const inputs = useInputs(allInputsIds.length > 0 ? allInputsIds : undefined)
  const inputValues = useMemo(() => inputsToValues(inputs), [inputs])
  
  // Extract template variables from script content (input dependencies)
  const inputDependencies = useMemo(() => {
    return extractTemplateVariables(rawScriptContent)
  }, [rawScriptContent])
  
  // Check if we have all input dependencies satisfied
  const hasAllInputDependencies = useMemo(() => {
    if (inputDependencies.length === 0) return true // No variables needed
    
    return inputDependencies.every(varName => {
      const value = inputValues[varName]
      return value !== undefined && value !== null && value !== ''
    })
  }, [inputDependencies, inputValues])
  
  // Get all block outputs from context to check dependencies
  const allOutputs = useAllOutputs()
  
  // Get AWS auth credentials from outputs if awsAuthId is specified
  // These will be passed as per-execution env vars (overriding session env)
  const awsAuthEnvVars = useMemo((): Record<string, string> | undefined => {
    if (!awsAuthId) return undefined
    
    // Normalize the ID (hyphens → underscores) to match how outputs are stored
    const normalizedId = awsAuthId.replace(/-/g, '_')
    const blockOutputs = allOutputs[normalizedId]
    
    if (!blockOutputs?.values) return undefined
    
    // Return the outputs as env vars (only include non-empty values)
    const envVars: Record<string, string> = {}
    for (const [key, value] of Object.entries(blockOutputs.values)) {
      if (value !== '') {
        envVars[key] = value
      }
    }
    
    return Object.keys(envVars).length > 0 ? envVars : undefined
  }, [awsAuthId, allOutputs])
  
  // Extract output dependencies from script content (e.g., {{ ._blocks.create-account.outputs.account_id }})
  const outputDependencies = useMemo(() => {
    return extractOutputDependenciesFromString(rawScriptContent)
  }, [rawScriptContent])
  
  // Check which output dependencies are not yet satisfied
  const unmetOutputDependencies = useMemo((): UnmetOutputDependency[] => {
    if (outputDependencies.length === 0) return []
    
    // Group dependencies by block
    const byBlock = groupDependenciesByBlock(outputDependencies)
    const unmet: UnmetOutputDependency[] = []
    
    for (const [blockId, outputNames] of byBlock) {
      const blockData = allOutputs[blockId]
      if (!blockData) {
        // Block hasn't produced any outputs yet
        unmet.push({ blockId, outputNames })
      } else {
        // Check which specific outputs are missing
        const missingOutputs = outputNames.filter(name => !(name in blockData.values))
        if (missingOutputs.length > 0) {
          unmet.push({ blockId, outputNames: missingOutputs })
        }
      }
    }
    
    return unmet
  }, [outputDependencies, allOutputs])
  
  // Check if all output dependencies are satisfied
  const hasAllOutputDependencies = unmetOutputDependencies.length === 0
  
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
  // Pass onFilesCaptured callback to update file tree when command captures files
  // Pass onFilesCaptured and onOutputsCaptured callbacks
  // Files written to $RUNBOOK_FILES are automatically captured after successful execution
  const { state: execState, execute: executeScript, executeByComponentId, cancel: cancelExec } = useApiExec({
    onFilesCaptured: handleFilesCaptured,
    onOutputsCaptured: handleOutputsCaptured,
  })
  
  // Map exec state to our status type, handling warn status for Check components
  // Note: componentType never changes, so we can directly check without memoization
  const status: ExecutionStatus = 
    execState.status === 'warn' && componentType === 'command' 
      ? 'fail' 
      : execState.status as ExecutionStatus
  
  const logs = execState.logs
  const execError = execState.error
  const outputs = execState.outputs
  
  // Register logs with global context whenever they change
  useEffect(() => {
    registerLogs(componentId, logs)
  }, [componentId, logs, registerLogs])

  // Function to render script with inputs
  const renderScript = useCallback(async (inputs: InputValue[]) => {
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
    }
    
    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateFiles,
          inputs,
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
    // Only render if we have template variables and all input dependencies are available
    if (inputDependencies.length === 0) {
      // No template variables, use raw script
      setRenderedScript(null)
      return
    }
    
    if (!hasAllInputDependencies) {
      // Input dependencies not available yet
      return
    }
    
    // Build inputs array for the API:
    // 1. Include input variables (with proper types for JSON-to-Go conversion)
    // 2. Add _blocks namespace as a map type for block output references
    const blocksNamespace: Record<string, { outputs: Record<string, string> }> = {}
    for (const [blockId, data] of Object.entries(allOutputs)) {
      blocksNamespace[blockId] = { outputs: data.values }
    }
    
    const inputsForRender: InputValue[] = [
      // Filter out any input named "_blocks" since that's a reserved system namespace
      ...inputs.filter(i => i.name !== '_blocks'),
      // Add _blocks as a map type containing all block outputs
      { name: '_blocks', type: BoilerplateVariableType.Map, value: blocksNamespace },
    ]
    
    // Check if inputs actually changed
    const inputsKey = JSON.stringify(inputsForRender)
    if (inputsKey === lastRenderedVariablesRef.current) {
      return
    }
    
    // Clear existing timer (handles cleanup when dependencies change)
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current)
    }
    
    // Capture current inputs in closure to avoid race condition
    const inputsToRender = inputsForRender
    const keyToStore = inputsKey
    
    // Debounce: wait 300ms after last change before rendering
    autoUpdateTimerRef.current = setTimeout(() => {
      lastRenderedVariablesRef.current = keyToStore
      renderScript(inputsToRender)
    }, 300)
    
    // Cleanup: clear timer when effect re-runs or on unmount
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current)
      }
    }
  }, [inputValues, allOutputs, inputs, inputDependencies.length, hasAllInputDependencies, renderScript])

  // Handle starting execution
  const execute = useCallback(() => {
    // Clear any previous registry error
    setRegistryError(null)
    
    // Get merged template variables (inputs at root + _blocks namespace)
    const templateVars = getTemplateVariables(allInputsIds.length > 0 ? allInputsIds : undefined)
    
    // Convert input variables to strings, but preserve _blocks structure as-is
    // for nested template access like {{ ._blocks.create-account.outputs.account_id }}
    const processedVariables: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(templateVars)) {
      if (key === '_blocks') {
        // Keep _blocks as nested object for Go template engine
        processedVariables[key] = value
      } else {
        // Convert other values to strings
        processedVariables[key] = String(value)
      }
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
      
      executeScript(executable.id, processedVariables as Record<string, string>, awsAuthEnvVars)
    } else {
      // Live reload mode: Send component ID directly
      executeByComponentId(componentId, processedVariables as Record<string, string>, awsAuthEnvVars)
    }
  }, [execRegistryEnabled, executeScript, executeByComponentId, componentId, getExecutableByComponentId, allInputsIds, getTemplateVariables, awsAuthEnvVars])

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
      
      // Cleanup outputs when component unmounts to prevent memory leaks
      unregisterOutputs(componentId)
    }
  }, [cancelExec, componentId, unregisterOutputs])

  // Combine exec error and registry error - show registry error if present
  const combinedExecError = registryError || execError

  return {
    // Script content
    sourceCode,
    language,
    
    // File loading
    fileError: getFileError,
    
    // Variables
    inputValues,
    inputDependencies,
    hasAllInputDependencies,
    inlineInputsId,
    
    // Output dependencies
    outputDependencies,
    unmetOutputDependencies,
    hasAllOutputDependencies,
    
    // Rendering
    isRendering,
    renderError,
    
    // Execution
    status,
    logs,
    execError: combinedExecError,
    execute,
    cancel: cancelExec,
    
    // Block outputs
    outputs,
    
    // Drift detection
    hasScriptDrift,
  }
}

