import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { Events } from '@wailsio/runtime'
import { createAppError, type AppError } from '@/types/error'
import { FileTreeNodeArraySchema } from '@/components/artifacts/code/FileTree.types'
import { useSession } from '@/contexts/useSession'
import { isDesktop } from '@/lib/wails'
import * as ExecService from '@/bindings/github.com/gruntwork-io/runbooks/services/execservice'
import { ExecRequest } from '@/bindings/github.com/gruntwork-io/runbooks/api/models'

// Zod schemas for SSE events
const ExecLogEventSchema = z.object({
  line: z.string(),
  timestamp: z.string(),
  replace: z.boolean().optional(), // If true, replace the previous line (for progress updates)
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

const BlockOutputsEventSchema = z.object({
  outputs: z.record(z.string(), z.string()),
})

// Inferred types from Zod schemas
export type ExecLogEvent = z.infer<typeof ExecLogEventSchema>
export type ExecStatusEvent = z.infer<typeof ExecStatusEventSchema>
export type CapturedFile = z.infer<typeof CapturedFileSchema>
export type FilesCapturedEvent = z.infer<typeof FilesCapturedEventSchema>
export type BlockOutputsEvent = z.infer<typeof BlockOutputsEventSchema>

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
  outputs: Record<string, string> | null
}

export interface UseApiExecOptions {
  /** Callback invoked when files are captured from a command execution */
  onFilesCaptured?: (event: FilesCapturedEvent) => void
  /** Callback invoked when block outputs are captured from script execution */
  onOutputsCaptured?: (outputs: Record<string, string>) => void
}

export interface UseApiExecReturn {
  state: ExecState
  execute: (executableId: string, variables?: Record<string, unknown>, envVars?: Record<string, string>, usePty?: boolean) => void
  executeByComponentId: (componentId: string, variables?: Record<string, unknown>, envVars?: Record<string, string>, usePty?: boolean) => void
  cancel: () => void
  reset: () => void
}

/**
 * Hook to execute scripts via the /api/exec endpoint with SSE streaming
 * Uses executable IDs from the executable registry instead of raw script content
 */
export function useApiExec(options?: UseApiExecOptions): UseApiExecReturn {
  const { onFilesCaptured, onOutputsCaptured } = options || {}
  const { getAuthHeader, getToken } = useSession()
  const [state, setState] = useState<ExecState>({
    logs: [],
    status: 'pending',
    exitCode: null,
    error: null,
    outputs: null,
  })

  const eventSourceRef = useRef<EventSource | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Desktop IPC run tracking: runID returned by ExecService.Run + the
  // unsubscribe functions for each event topic we're listening on.
  const runIDRef = useRef<string | null>(null)
  const ipcUnsubsRef = useRef<Array<() => void>>([])

  // Cancel-while-starting guard. cancel() flips this to true; the
  // ExecService.Run resolver checks it before subscribing. Without
  // this, a cancel issued during the Run await window is lost — the
  // refs it inspects are still empty, and by the time Run returns the
  // backend goroutine is already alive with no listeners attached.
  const runStartCancelledRef = useRef(false)

  const cancel = useCallback(() => {
    // Track if there was actually something to cancel
    const hadActiveExecution =
      eventSourceRef.current !== null ||
      abortControllerRef.current !== null ||
      runIDRef.current !== null

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

    // Cancel IPC run: unsubscribe event listeners and ask the backend to
    // stop the running goroutine. Backend Cancel is idempotent.
    if (ipcUnsubsRef.current.length > 0) {
      for (const unsub of ipcUnsubsRef.current) unsub()
      ipcUnsubsRef.current = []
    }
    if (runIDRef.current) {
      const rid = runIDRef.current
      runIDRef.current = null
      ExecService.Cancel(rid).catch((err) => {
        console.error('[useApiExec] IPC cancel failed:', err)
      })
    }

    // Signal any in-flight ExecService.Run awaiting a runID that the
    // user has cancelled. The resolver cancels the returned runID
    // instead of subscribing, so no backend goroutine leaks.
    runStartCancelledRef.current = true

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
      outputs: null,
    })
  }, [cancel])

  // Desktop-mode execution: call ExecService.Run over Wails IPC and
  // subscribe to `exec:<runID>:*` topic events. Mirrors the SSE handler
  // below in terms of state transitions and Zod validation so both
  // transports surface identical bugs and error messages.
  const executeOverIpc = useCallback(
    async (payload: {
      executable_id?: string
      component_id?: string
      template_var_values: Record<string, unknown>
      env_vars_override?: Record<string, string>
      use_pty?: boolean
    }) => {
      // Starting a fresh run: clear any stale cancel signal left over
      // from executeScript's cancel() call. A user-initiated cancel()
      // between here and the ExecService.Run resolution will re-raise
      // the flag, and the post-await check below will honor it.
      runStartCancelledRef.current = false

      try {
        const req = ExecRequest.createFrom({
          executable_id: payload.executable_id,
          component_id: payload.component_id,
          template_var_values: payload.template_var_values,
          env_vars_override: payload.env_vars_override,
          use_pty: payload.use_pty,
        })
        const token = getToken() ?? ''
        const result = await ExecService.Run(token, req)

        // Cancel fired while Run was in flight. Roll back the
        // just-started backend run and skip subscription setup so no
        // listeners leak and no runIDRef is registered.
        if (runStartCancelledRef.current) {
          if (result?.runId) {
            ExecService.Cancel(result.runId).catch((err) => {
              console.error('[useApiExec] IPC late-cancel failed:', err)
            })
          }
          return
        }

        if (!result) {
          setState((prev) => ({
            ...prev,
            status: 'fail',
            error: createAppError('Failed to start execution', 'ExecService.Run returned null'),
            logs: [...prev.logs, createLogEntry('Error: ExecService.Run returned null')],
          }))
          return
        }

        const runID = result.runId
        runIDRef.current = runID

        const topic = (event: string) => `exec:${runID}:${event}`
        const unsubs: Array<() => void> = []

        unsubs.push(
          Events.On(topic('log'), (ev) => {
            const parsed = ExecLogEventSchema.safeParse(ev.data)
            if (!parsed.success) {
              console.error('Invalid log event:', parsed.error)
              setState((prev) => ({
                ...prev,
                logs: [...prev.logs, createLogEntry('[Unable to parse log output]')],
              }))
              return
            }
            const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
            setState((prev) => {
              if (parsed.data.replace && prev.logs.length > 0) {
                const updatedLogs = [...prev.logs]
                updatedLogs[updatedLogs.length - 1] = newEntry
                return { ...prev, logs: updatedLogs }
              }
              return { ...prev, logs: [...prev.logs, newEntry] }
            })
          }),
        )

        unsubs.push(
          Events.On(topic('status'), (ev) => {
            const parsed = ExecStatusEventSchema.safeParse(ev.data)
            if (!parsed.success) {
              console.error('Invalid status event:', parsed.error)
              setState((prev) => ({
                ...prev,
                status: 'fail',
                error: createAppError(
                  'Failed to parse execution status',
                  'The desktop app received a malformed status event. This may indicate a version mismatch.',
                ),
              }))
              return
            }
            setState((prev) => ({
              ...prev,
              status: parsed.data.status,
              exitCode: parsed.data.exitCode,
            }))
          }),
        )

        unsubs.push(
          Events.On(topic('outputs'), (ev) => {
            const parsed = BlockOutputsEventSchema.safeParse(ev.data)
            if (!parsed.success) {
              console.error('Invalid outputs event:', parsed.error)
              return
            }
            setState((prev) => ({ ...prev, outputs: parsed.data.outputs }))
            if (onOutputsCaptured) onOutputsCaptured(parsed.data.outputs)
          }),
        )

        unsubs.push(
          Events.On(topic('files_captured'), (ev) => {
            const parsed = FilesCapturedEventSchema.safeParse(ev.data)
            if (!parsed.success) {
              console.error('Invalid files_captured event:', parsed.error)
              setState((prev) => ({
                ...prev,
                error: createAppError(
                  'Files captured but not displayed',
                  'Your files were saved successfully, but could not be shown in the file tree. Check the output directory manually.',
                ),
                logs: [...prev.logs, createLogEntry('⚠️ Files were captured but could not be displayed')],
              }))
              return
            }
            if (onFilesCaptured) onFilesCaptured(parsed.data)
            setState((prev) => ({
              ...prev,
              logs: [...prev.logs, createLogEntry(`📁 Captured ${parsed.data.count} file(s) to workspace`)],
            }))
          }),
        )

        unsubs.push(
          Events.On(topic('error'), (ev) => {
            const parsed = ExecErrorEventSchema.safeParse(ev.data)
            const errorData = parsed.success
              ? parsed.data
              : { message: undefined, details: undefined }
            setState((prev) => ({
              ...prev,
              status: 'fail',
              error: createAppError(
                errorData.message || 'Unknown error',
                errorData.details || 'An error occurred during script execution',
              ),
            }))
          }),
        )

        unsubs.push(
          Events.On(topic('done'), () => {
            // Release listeners and the run slot. Status event already
            // transitioned the UI; `done` is just the terminal signal.
            for (const u of ipcUnsubsRef.current) u()
            ipcUnsubsRef.current = []
            runIDRef.current = null
          }),
        )

        ipcUnsubsRef.current = unsubs
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        setState((prev) => ({
          ...prev,
          status: 'fail',
          error: createAppError('Failed to start script execution', errorMessage),
          logs: [...prev.logs, createLogEntry(`Error: ${errorMessage}`)],
        }))
      }
    },
    [getToken, onFilesCaptured, onOutputsCaptured],
  )

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
              const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
              setState((prev) => {
                // If replace flag is set and we have previous logs, replace the last one
                if (parsed.data.replace && prev.logs.length > 0) {
                  const updatedLogs = [...prev.logs]
                  updatedLogs[updatedLogs.length - 1] = newEntry
                  return { ...prev, logs: updatedLogs }
                }
                // Otherwise append as normal
                return { ...prev, logs: [...prev.logs, newEntry] }
              })
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
          } else if (eventType === 'outputs') {
            // Block outputs were captured from script execution
            const parsed = BlockOutputsEventSchema.safeParse(data)
            if (parsed.success) {
              // Store outputs in state
              setState((prev) => ({
                ...prev,
                outputs: parsed.data.outputs,
              }))
              // Invoke callback if provided
              if (onOutputsCaptured) {
                onOutputsCaptured(parsed.data.outputs)
              }
            } else {
              console.error('Invalid outputs event:', parsed.error)
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
  }, [onFilesCaptured, onOutputsCaptured])

  // Shared execution logic for both registry and live-reload modes
  const executeScript = useCallback(async (
    payload: { 
      executable_id?: string; 
      component_id?: string; 
      template_var_values: Record<string, unknown>;
      env_vars_override?: Record<string, string>;
      use_pty?: boolean;
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
      outputs: null,
    })

    if (isDesktop()) {
      await executeOverIpc(payload)
      return
    }

    try {
      // Create abort controller for fetch request
      const abortController = new AbortController()
      abortControllerRef.current = abortController

      // Send POST request to /api/exec
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
  }, [cancel, processSSEStream, executeOverIpc, getAuthHeader])

  // Execute script by executable ID (used in registry mode)
  const execute = useCallback(
    (executableId: string, templateVarValues: Record<string, unknown> = {}, envVarsOverride?: Record<string, string>, usePty?: boolean) => {
      executeScript({ 
        executable_id: executableId, 
        template_var_values: templateVarValues,
        env_vars_override: envVarsOverride,
        use_pty: usePty,
      })
    },
    [executeScript]
  )

  // Execute script by component ID (used in live-reload mode)
  // Unlike execute() which uses pre-validated executable IDs from the registry,
  // this sends the component ID to the backend, which then reads the gruntbook file
  // from disk on-demand, parses it to find the component, and executes its script.
  // This allows script changes to take effect immediately without restarting the server,
  // but bypasses registry validation (only use with --live-file-reload flag).
  const executeByComponentId = useCallback(
    (componentId: string, templateVarValues: Record<string, unknown> = {}, envVarsOverride?: Record<string, string>, usePty?: boolean) => {
      executeScript({ 
        component_id: componentId, 
        template_var_values: templateVarValues,
        env_vars_override: envVarsOverride,
        use_pty: usePty,
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

