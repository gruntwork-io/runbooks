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
  execute: (executableId: string, variables?: Record<string, unknown>, envVars?: Record<string, string>, usePty?: boolean, timeoutMs?: number) => void
  executeByComponentId: (componentId: string, variables?: Record<string, unknown>, envVars?: Record<string, string>, usePty?: boolean, timeoutMs?: number) => void
  cancel: () => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Global execution ID
// ---------------------------------------------------------------------------
// Only one script can execute at a time (the main process cancels any active
// execution before starting a new one). This counter lets each hook instance
// know whether *it* owns the current execution. Listeners registered by a
// previous execution will see that `activeExecId` has moved on and silently
// discard events that belong to a newer run.
let activeExecId = 0

/**
 * Hook to execute scripts via IPC with streaming event listeners.
 * Uses executable IDs from the executable registry instead of raw script content.
 */
export function useApiExec(options?: UseApiExecOptions): UseApiExecReturn {
  const [state, setState] = useState<ExecState>({
    logs: [],
    status: 'pending',
    exitCode: null,
    error: null,
    outputs: null,
  })

  const cleanupRef = useRef<(() => void) | null>(null)
  const executionGenRef = useRef(0)

  const cancel = useCallback(() => {
    const hadActiveExecution = cleanupRef.current !== null

    // Signal the backend to cancel the active execution (kill child process)
    if (hadActiveExecution) {
      window.api.invoke('exec:cancel').catch(() => {})
    }

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
      executableId?: string;
      componentId?: string;
      templateVarValues: Record<string, unknown>;
      envVarsOverride?: Record<string, string>;
      usePty?: boolean;
      timeoutMs?: number;
    }
  ) => {
    // Cancel any existing execution and bump generation
    cancel()
    const generation = ++executionGenRef.current

    // Claim global ownership so that listeners from previously-run blocks
    // (which are still subscribed) will silently discard our events.
    const execId = ++activeExecId

    // Reset state for new execution
    setState({
      logs: [],
      status: 'running',
      exitCode: null,
      error: null,
      outputs: null,
    })

    // Subscribe to IPC streaming events before starting execution.
    // Each listener guards against stale delivery: if another block has
    // started a newer execution (activeExecId moved on), we ignore the event.
    const unsubs: (() => void)[] = []

    unsubs.push(window.api.on('exec:log', (data: unknown) => {
      if (activeExecId !== execId) return
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
      if (activeExecId !== execId) return
      const parsed = BlockOutputsEventSchema.safeParse(data)
      if (parsed.success) {
        setState((prev) => ({ ...prev, outputs: parsed.data.outputs }))
        options?.onOutputsCaptured?.(parsed.data.outputs)
      }
    }))

    unsubs.push(window.api.on('exec:files-captured', (data: unknown) => {
      if (activeExecId !== execId) return
      const parsed = FilesCapturedEventSchema.safeParse(data)
      if (parsed.success) {
        options?.onFilesCaptured?.(parsed.data)
      }
    }))

    unsubs.push(window.api.on('exec:status', (data: unknown) => {
      if (activeExecId !== execId) return
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
      // The invoke resolved — the main process has sent all events.
      // Schedule listener cleanup on the next macrotask so any IPC events
      // still queued in the renderer's event loop are dispatched first.
      setTimeout(() => {
        if (generation === executionGenRef.current) {
          cleanup()
          cleanupRef.current = null
        }
      }, 0)
    } catch (error) {
      // Only update state if this execution is still current
      if (generation === executionGenRef.current) {
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
        // Clean up listeners on error (no more events expected)
        cleanup()
        cleanupRef.current = null
      }
    }
  }, [cancel, options])

  // Execute script by executable ID (used in registry mode)
  const execute = useCallback(
    (executableId: string, templateVarValues: Record<string, unknown> = {}, envVarsOverride?: Record<string, string>, usePty?: boolean, timeoutMs?: number) => {
      executeScript({
        executableId,
        templateVarValues,
        envVarsOverride,
        usePty,
        timeoutMs,
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
    (componentId: string, templateVarValues: Record<string, unknown> = {}, envVarsOverride?: Record<string, string>, usePty?: boolean, timeoutMs?: number) => {
      executeScript({
        componentId,
        templateVarValues,
        envVarsOverride,
        usePty,
        timeoutMs,
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

