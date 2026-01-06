import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { createAppError, type AppError } from '@/types/error'
import { FileTreeNodeArraySchema } from '@/components/artifacts/code/FileTree.types'
import { useSession } from '@/contexts/useSession'

// Zod schemas for SSE events
const ExecLogEventSchema = z.object({
  line: z.string(),
  timestamp: z.string(),
})

const ExecStatusEventSchema = z.object({
  status: z.enum(['success', 'warn', 'fail']),
  exitCode: z.number(),
})

const CapturedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
})

const FilesCapturedEventSchema = z.object({
  files: z.array(CapturedFileSchema),
  count: z.number(),
  fileTree: FileTreeNodeArraySchema,
})

const ExecErrorEventSchema = z.object({
  message: z.string().optional(),
  details: z.string().optional(),
})

// Inferred types from Zod schemas
export type ExecLogEvent = z.infer<typeof ExecLogEventSchema>
export type ExecStatusEvent = z.infer<typeof ExecStatusEventSchema>
export type CapturedFile = z.infer<typeof CapturedFileSchema>
export type FilesCapturedEvent = z.infer<typeof FilesCapturedEventSchema>

/** A single log entry with its timestamp */
export interface LogEntry {
  line: string
  timestamp: string
}

/** Create a log entry with the current timestamp */
function createLogEntry(line: string, timestamp?: string): LogEntry {
  return {
    line,
    timestamp: timestamp ?? new Date().toISOString(),
  }
}

export interface ExecState {
  logs: LogEntry[]
  status: 'pending' | 'running' | 'success' | 'warn' | 'fail'
  exitCode: number | null
  error: AppError | null
}

export interface CaptureFilesOptions {
  captureFiles?: boolean
  captureFilesOutputPath?: string
}

export interface UseApiExecOptions {
  /** Callback invoked when files are captured from a command execution */
  onFilesCaptured?: (event: FilesCapturedEvent) => void
}

export interface UseApiExecReturn {
  state: ExecState
  execute: (executableId: string, variables?: Record<string, string>, captureOptions?: CaptureFilesOptions) => void
  executeByComponentId: (componentId: string, variables?: Record<string, string>, captureOptions?: CaptureFilesOptions) => void
  cancel: () => void
  reset: () => void
}

/**
 * Hook to execute scripts via the /api/exec endpoint with SSE streaming
 * Uses executable IDs from the executable registry instead of raw script content
 * 
 * Integrates with SessionContext for persistent environment support:
 * - Sends Authorization header for session validation
 * - Environment changes made by scripts persist to subsequent executions
 */
export function useApiExec(options?: UseApiExecOptions): UseApiExecReturn {
  const { onFilesCaptured } = options || {}
  const { getAuthHeader } = useSession()
  
  const [state, setState] = useState<ExecState>({
    logs: [],
    status: 'pending',
    exitCode: null,
    error: null,
  })

  const eventSourceRef = useRef<EventSource | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    // Track if there was actually something to cancel
    const hadActiveExecution = eventSourceRef.current !== null || abortControllerRef.current !== null

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

    // Only add cancellation log and update state if there was actually an active execution
    if (hadActiveExecution) {
      setState((prev) => ({
        ...prev,
        status: 'pending',
        logs: [...prev.logs, createLogEntry('⚠️ Execution cancelled by user')],
      }))
    }
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
            const parsed = ExecLogEventSchema.safeParse(data)
            if (parsed.success) {
              setState((prev) => ({
                ...prev,
                logs: [...prev.logs, createLogEntry(parsed.data.line, parsed.data.timestamp)],
              }))
            } else {
              // Non-critical: show placeholder so user knows output was received
              console.error('Invalid log event:', parsed.error)
              setState((prev) => ({
                ...prev,
                logs: [...prev.logs, createLogEntry('[Unable to parse log output]')],
              }))
            }
          } else if (eventType === 'status') {
            const parsed = ExecStatusEventSchema.safeParse(data)
            if (parsed.success) {
              setState((prev) => ({
                ...prev,
                status: parsed.data.status,
                exitCode: parsed.data.exitCode,
              }))
            } else {
              // Critical: without status, UI would be stuck in "running" state
              console.error('Invalid status event:', parsed.error)
              setState((prev) => ({
                ...prev,
                status: 'fail',
                error: createAppError(
                  'Failed to parse execution status',
                  'The server response was malformed. This may indicate a version mismatch.'
                ),
              }))
            }
          } else if (eventType === 'files_captured') {
            // Files were captured from script execution
            const parsed = FilesCapturedEventSchema.safeParse(data)
            if (parsed.success) {
              if (onFilesCaptured) {
                onFilesCaptured(parsed.data)
              }
              // Also log that files were captured
              setState((prev) => ({
                ...prev,
                logs: [...prev.logs, createLogEntry(`📁 Captured ${parsed.data.count} file(s) to workspace`)],
              }))
            } else {
              // File tree won't update - show error so user knows to check manually
              console.error('Invalid files_captured event:', parsed.error)
              setState((prev) => ({
                ...prev,
                error: createAppError(
                  'Files captured but not displayed',
                  'Your files were saved successfully, but could not be shown in the file tree. Check the output directory manually.'
                ),
                logs: [...prev.logs, createLogEntry('⚠️ Files were captured but could not be displayed')],
              }))
            }
          } else if (eventType === 'done') {
            // Execution complete
            break
          } else if (eventType === 'error') {
            const parsed = ExecErrorEventSchema.safeParse(data)
            const errorData = parsed.success ? parsed.data : { message: undefined, details: undefined }
            setState((prev) => ({
              ...prev,
              status: 'fail',
              error: createAppError(
                errorData.message || 'Unknown error',
                errorData.details || 'An error occurred during script execution'
              ),
            }))
          }
        } catch (e) {
          // JSON parse error - show to user rather than silently failing
          console.error('Failed to parse SSE message:', e, eventData)
          setState((prev) => ({
            ...prev,
            logs: [...prev.logs, createLogEntry(`[Malformed server response: ${eventType}]`)],
          }))
        }
      }
    }
  }, [onFilesCaptured])

  // Shared execution logic for both registry and live-reload modes
  const executeScript = useCallback(async (
    payload: { 
      executable_id?: string; 
      component_id?: string; 
      template_var_values: Record<string, string>;
      capture_files?: boolean;
      capture_files_output_path?: string;
    }
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

      // Send POST request to /api/exec with session auth header
      const response = await fetch('/api/exec', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(),
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
          logs: [...prev.logs, createLogEntry(`Error: ${errorMessage}`)],
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
        logs: [...prev.logs, createLogEntry(`Error: ${errorMessage}`)],
      }))
    } finally {
      abortControllerRef.current = null
    }
  }, [cancel, processSSEStream, getAuthHeader])

  // Execute script by executable ID (used in registry mode)
  const execute = useCallback(
    (executableId: string, templateVarValues: Record<string, string> = {}, captureOptions?: CaptureFilesOptions) => {
      executeScript({ 
        executable_id: executableId, 
        template_var_values: templateVarValues,
        capture_files: captureOptions?.captureFiles,
        capture_files_output_path: captureOptions?.captureFilesOutputPath,
      })
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
    (componentId: string, templateVarValues: Record<string, string> = {}, captureOptions?: CaptureFilesOptions) => {
      executeScript({ 
        component_id: componentId, 
        template_var_values: templateVarValues,
        capture_files: captureOptions?.captureFiles,
        capture_files_output_path: captureOptions?.captureFilesOutputPath,
      })
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

