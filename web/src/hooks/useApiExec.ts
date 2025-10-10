import { useCallback, useRef, useState } from 'react'
import { createAppError, type AppError } from '@/types/error'

export interface ExecLogEvent {
  line: string
  timestamp: string
}

export interface ExecStatusEvent {
  status: 'success' | 'warn' | 'fail'
  exitCode: number
}

export interface ExecState {
  logs: string[]
  status: 'pending' | 'running' | 'success' | 'warn' | 'fail'
  exitCode: number | null
  error: AppError | null
}

export interface UseApiExecReturn {
  state: ExecState
  execute: (executableId: string, variables?: Record<string, string>) => void
  executeByComponentId: (componentId: string, variables?: Record<string, string>) => void
  cancel: () => void
  reset: () => void
}

/**
 * Hook to execute scripts via the /api/exec endpoint with SSE streaming
 * Uses executable IDs from the executable registry instead of raw script content
 */
export function useApiExec(): UseApiExecReturn {
  const [state, setState] = useState<ExecState>({
    logs: [],
    status: 'pending',
    exitCode: null,
    error: null,
  })

  const eventSourceRef = useRef<EventSource | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    // Close SSE connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    // Abort fetch request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }

    setState((prev) => ({
      ...prev,
      status: 'pending',
      logs: [...prev.logs, '⚠️ Execution cancelled by user'],
    }))
  }, [])

  const reset = useCallback(() => {
    cancel()
    setState({
      logs: [],
      status: 'pending',
      exitCode: null,
      error: null,
    })
  }, [cancel])

  // Process SSE (Server-Sent Events) stream from the server
  // Receives and handles all execution events: logs, status updates, exit codes, and errors
  const processSSEStream = useCallback(async (response: Response) => {
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()

    if (!reader) {
      throw new Error('Response body is not readable')
    }

    let buffer = ''

    // Read the stream
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE messages (separated by \n\n)
      const messages = buffer.split('\n\n')
      buffer = messages.pop() || '' // Keep incomplete message in buffer

      for (const message of messages) {
        if (!message.trim()) continue

        // Parse SSE message format:
        // event: log
        // data: {"line":"...", "timestamp":"..."}
        const lines = message.split('\n')
        let eventType = 'message'
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.substring(6).trim()
          } else if (line.startsWith('data:')) {
            eventData = line.substring(5).trim()
          }
        }

        try {
          const data = JSON.parse(eventData)

          if (eventType === 'log') {
            const logEvent = data as ExecLogEvent
            setState((prev) => ({
              ...prev,
              logs: [...prev.logs, logEvent.line],
            }))
          } else if (eventType === 'status') {
            const statusEvent = data as ExecStatusEvent
            setState((prev) => ({
              ...prev,
              status: statusEvent.status,
              exitCode: statusEvent.exitCode,
            }))
          } else if (eventType === 'done') {
            // Execution complete
            break
          } else if (eventType === 'error') {
            setState((prev) => ({
              ...prev,
              status: 'fail',
              error: createAppError(
                data.message || 'Unknown error',
                data.details || 'An error occurred during script execution'
              ),
            }))
          }
        } catch (e) {
          console.error('Failed to parse SSE message:', e, eventData)
        }
      }
    }
  }, [])

  // Shared execution logic for both registry and live-reload modes
  const executeScript = useCallback(async (
    payload: { executable_id?: string; component_id?: string; template_var_values: Record<string, string> }
  ) => {
    // Cancel any existing execution
    cancel()

    // Reset state for new execution
    setState({
      logs: [],
      status: 'running',
      exitCode: null,
      error: null,
    })

    try {
      // Create abort controller for fetch request
      const abortController = new AbortController()
      abortControllerRef.current = abortController

      // Send POST request to /api/exec
      const response = await fetch('/api/exec', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        const errorMessage = errorData?.error || `HTTP error: ${response.status}`

        setState((prev) => ({
          ...prev,
          status: 'fail',
          error: createAppError(
            errorMessage,
            errorData?.details || 'Failed to execute script on the server'
          ),
          logs: [...prev.logs, `Error: ${errorMessage}`],
        }))

        return
      }

      // Process the SSE stream
      await processSSEStream(response)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Cancelled by user, already handled in cancel()
        return
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      setState((prev) => ({
        ...prev,
        status: 'fail',
        error: createAppError(
          'An unexpected error occurred while executing the script',
          errorMessage
        ),
        logs: [...prev.logs, `Error: ${errorMessage}`],
      }))
    } finally {
      abortControllerRef.current = null
    }
  }, [cancel, processSSEStream])

  // Execute script by executable ID (used in registry mode)
  const execute = useCallback(
    (executableId: string, templateVarValues: Record<string, string> = {}) => {
      executeScript({ executable_id: executableId, template_var_values: templateVarValues })
    },
    [executeScript]
  )

  // Execute script by component ID (used in live-reload mode)
  // Unlike execute() which uses pre-validated executable IDs from the registry,
  // this sends the component ID to the backend, which then reads the runbook file
  // from disk on-demand, parses it to find the component, and executes its script.
  // This allows script changes to take effect immediately without restarting the server,
  // but bypasses registry validation (only use with --live-file-reload flag).
  const executeByComponentId = useCallback(
    (componentId: string, templateVarValues: Record<string, string> = {}) => {
      executeScript({ component_id: componentId, template_var_values: templateVarValues })
    },
    [executeScript]
  )

  return {
    state,
    execute,
    executeByComponentId,
    cancel,
    reset,
  }
}

