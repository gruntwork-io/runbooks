import { useCallback, useRef, useState, useEffect } from 'react'
import { z } from 'zod'
import { createAppError, type AppError } from '@/types/error'
import { FileTreeNodeArraySchema } from '@/components/artifacts/code/FileTree.types'
import { useApi } from '@/contexts/ApiContext'

// Zod schemas for IPC events (same as SSE events)
const ExecLogEventSchema = z.object({
  line: z.string(),
  timestamp: z.string(),
  replace: z.boolean().optional(),
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

export interface UseIpcExecOptions {
  /** Callback invoked when files are captured from a command execution */
  onFilesCaptured?: (event: FilesCapturedEvent) => void
  /** Callback invoked when block outputs are captured from script execution */
  onOutputsCaptured?: (outputs: Record<string, string>) => void
}

export interface UseIpcExecReturn {
  state: ExecState
  execute: (executableId: string, variables?: Record<string, unknown>, envVars?: Record<string, string>, usePty?: boolean) => void
  executeByComponentId: (componentId: string, variables?: Record<string, unknown>, envVars?: Record<string, string>, usePty?: boolean) => void
  cancel: () => void
  reset: () => void
}

/**
 * Hook to execute scripts via IPC with streaming event listeners.
 * Replaces useApiExec which used SSE streaming over HTTP.
 */
export function useIpcExec(options?: UseIpcExecOptions): UseIpcExecReturn {
  const { onFilesCaptured, onOutputsCaptured } = options || {}
  const api = useApi()
  const [state, setState] = useState<ExecState>({
    logs: [],
    status: 'pending',
    exitCode: null,
    error: null,
    outputs: null,
  })

  // Track cleanup functions for active event subscriptions
  const cleanupRef = useRef<(() => void) | null>(null)

  // Clean up subscriptions on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [])

  const cancel = useCallback(() => {
    const hadActiveExecution = cleanupRef.current !== null

    // Clean up event subscriptions
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }

    // Send cancel signal to backend
    api.invoke('exec:cancel').catch(() => {
      // Ignore errors when cancelling — execution may already be finished
    })

    if (hadActiveExecution) {
      setState((prev) => ({
        ...prev,
        status: 'pending',
        logs: [...prev.logs, createLogEntry('Warning: Execution cancelled by user')],
      }))
    }
  }, [api])

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

  // Shared execution logic
  const executeScript = useCallback(async (
    payload: {
      executable_id?: string
      component_id?: string
      template_var_values: Record<string, unknown>
      env_vars_override?: Record<string, string>
      use_pty?: boolean
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

    // Subscribe to events BEFORE starting execution
    const unsubs: (() => void)[] = []

    const unsubLog = api.on('exec:log', (...args: unknown[]) => {
      const data = args[0]
      const parsed = ExecLogEventSchema.safeParse(data)
      if (parsed.success) {
        const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
        setState((prev) => {
          if (parsed.data.replace && prev.logs.length > 0) {
            const updatedLogs = [...prev.logs]
            updatedLogs[updatedLogs.length - 1] = newEntry
            return { ...prev, logs: updatedLogs }
          }
          return { ...prev, logs: [...prev.logs, newEntry] }
        })
      } else {
        console.error('Invalid log event:', parsed.error)
        setState((prev) => ({
          ...prev,
          logs: [...prev.logs, createLogEntry('[Unable to parse log output]')],
        }))
      }
    })
    unsubs.push(unsubLog)

    const unsubStatus = api.on('exec:status', (...args: unknown[]) => {
      const data = args[0]
      const parsed = ExecStatusEventSchema.safeParse(data)
      if (parsed.success) {
        setState((prev) => ({
          ...prev,
          status: parsed.data.status,
          exitCode: parsed.data.exitCode,
        }))
      } else {
        console.error('Invalid status event:', parsed.error)
        setState((prev) => ({
          ...prev,
          status: 'fail',
          error: createAppError(
            'Failed to parse execution status',
            'The response was malformed. This may indicate a version mismatch.'
          ),
        }))
      }
    })
    unsubs.push(unsubStatus)

    const unsubOutputs = api.on('exec:outputs', (...args: unknown[]) => {
      const data = args[0]
      const parsed = BlockOutputsEventSchema.safeParse(data)
      if (parsed.success) {
        setState((prev) => ({
          ...prev,
          outputs: parsed.data.outputs,
        }))
        if (onOutputsCaptured) {
          onOutputsCaptured(parsed.data.outputs)
        }
      } else {
        console.error('Invalid outputs event:', parsed.error)
      }
    })
    unsubs.push(unsubOutputs)

    const unsubFiles = api.on('exec:files_captured', (...args: unknown[]) => {
      const data = args[0]
      const parsed = FilesCapturedEventSchema.safeParse(data)
      if (parsed.success) {
        if (onFilesCaptured) {
          onFilesCaptured(parsed.data)
        }
        setState((prev) => ({
          ...prev,
          logs: [...prev.logs, createLogEntry(`Captured ${parsed.data.count} file(s) to workspace`)],
        }))
      } else {
        console.error('Invalid files_captured event:', parsed.error)
        setState((prev) => ({
          ...prev,
          error: createAppError(
            'Files captured but not displayed',
            'Your files were saved successfully, but could not be shown in the file tree. Check the output directory manually.'
          ),
          logs: [...prev.logs, createLogEntry('Warning: Files were captured but could not be displayed')],
        }))
      }
    })
    unsubs.push(unsubFiles)

    const unsubError = api.on('exec:error', (...args: unknown[]) => {
      const data = args[0]
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
    })
    unsubs.push(unsubError)

    const cleanup = () => {
      for (const unsub of unsubs) {
        unsub()
      }
    }
    cleanupRef.current = cleanup

    try {
      await api.invoke('exec:run', payload)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
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
      // Clean up subscriptions after execution completes
      cleanup()
      cleanupRef.current = null
    }
  }, [api, cancel, onFilesCaptured, onOutputsCaptured])

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
