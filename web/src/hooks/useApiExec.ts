import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { createAppError, type AppError } from '@/types/error'
import { FileTreeNodeArraySchema } from '@/components/artifacts/code/FileTree.types'
// Zod schemas for IPC events
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
 * Hook to execute scripts via IPC with streaming event listeners.
 * Uses executable IDs from the executable registry instead of raw script content.
 */
export function useApiExec(options?: UseApiExecOptions): UseApiExecReturn {
  const { onFilesCaptured, onOutputsCaptured } = options || {}
  const [state, setState] = useState<ExecState>({
    logs: [],
    status: 'pending',
    exitCode: null,
    error: null,
    outputs: null,
  })

  const cleanupRef = useRef<(() => void) | null>(null)

  const cancel = useCallback(() => {
    const hadActiveExecution = cleanupRef.current !== null

    // Clean up IPC event subscriptions
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }

    // Only add cancellation log and update state if there was actually an active execution
    if (hadActiveExecution) {
      setState((prev) => ({
        ...prev,
        status: 'pending',
        logs: [...prev.logs, createLogEntry('Execution cancelled by user')],
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

    // Subscribe to IPC streaming events before starting execution
    const unsubs: (() => void)[] = []

    unsubs.push(window.api.on('exec:log', (data: unknown) => {
      const parsed = ExecLogEventSchema.safeParse(data)
      if (parsed.success) {
        const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
        setState((prev) => ({
          ...prev,
          logs: parsed.data.replace && prev.logs.length > 0
            ? [...prev.logs.slice(0, -1), newEntry]
            : [...prev.logs, newEntry],
        }))
      }
    }))

    unsubs.push(window.api.on('exec:outputs', (data: unknown) => {
      const parsed = BlockOutputsEventSchema.safeParse(data)
      if (parsed.success) {
        setState((prev) => ({ ...prev, outputs: parsed.data.outputs }))
        options?.onOutputsCaptured?.(parsed.data.outputs)
      }
    }))

    unsubs.push(window.api.on('exec:files-captured', (data: unknown) => {
      const parsed = FilesCapturedEventSchema.safeParse(data)
      if (parsed.success) {
        options?.onFilesCaptured?.(parsed.data)
      }
    }))

    unsubs.push(window.api.on('exec:status', (data: unknown) => {
      const parsed = ExecStatusEventSchema.safeParse(data)
      if (parsed.success) {
        setState((prev) => ({
          ...prev,
          status: parsed.data.status as ExecState['status'],
          exitCode: parsed.data.exitCode ?? null,
        }))
      }
    }))

    const cleanup = () => {
      for (const unsub of unsubs) unsub()
    }
    cleanupRef.current = cleanup

    try {
      await window.api.invoke('exec:run', payload)
    } catch (error) {
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
      cleanup()
      cleanupRef.current = null
    }
  }, [cancel, options])

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
  // this sends the component ID to the backend, which then reads the runbook file
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

