import { useCallback, useRef, useState } from "react"
import { z } from "zod"
import { createAppError, type AppError } from "@/types/error"
import { FileTreeNodeArraySchema } from "@/components/artifacts/code/FileTree.types"
import { decodeOutputs, type OutputValues } from "@/lib/outputValues"
import { omitUndefined } from "@/lib/omitUndefined"
import { useApi } from "@/contexts/ApiContext"
// Zod schemas for IPC events
const ExecLogEventSchema = z.object({
  line: z.string(),
  timestamp: z.string(),
  replace: z.boolean().optional(), // If true, replace the previous line (for progress updates)
})

const ExecStatusEventSchema = z.object({
  status: z.enum(["success", "warn", "fail"]),
  exitCode: z.number(),
})

const CapturedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
})

// fileTree is the whole generated-files tree after the capture; main omits it
// when the tree could not be read. The truncation fields sit beside it, as in
// a boilerplate:render response.
const FilesCapturedEventSchema = z.object({
  files: z.array(CapturedFileSchema),
  count: z.number(),
  fileTree: FileTreeNodeArraySchema.optional(),
  truncatedTree: z.boolean().optional(),
  totalFiles: z.number().optional(),
  heavyDirs: z.array(z.object({ path: z.string(), fileCount: z.number() })).optional(),
})

// Main sends each output flat, since a Redacted can't cross IPC. Parsing turns
// the sensitive ones back into Redacted values (see outputValues.ts).
const BlockOutputsEventSchema = z.object({
  outputs: z
    .record(z.string(), z.object({ value: z.string(), sensitive: z.boolean() }))
    .transform(decodeOutputs),
})

// Inferred types from Zod schemas
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
  status: "pending" | "running" | "success" | "warn" | "fail"
  exitCode: number | null
  error: AppError | null
  /** The script's outputs. Sensitive ones are `Redacted`. */
  outputs: OutputValues | null
  /** Absolute path to the on-disk log file for this execution, if available. */
  logFilePath: string | null
}

const ExecLogFileEventSchema = z.object({
  path: z.string(),
})

export interface UseApiExecOptions {
  /** Callback invoked when files are captured from a command execution */
  onFilesCaptured?: (event: FilesCapturedEvent) => void
  /** Callback invoked when block outputs are captured from script execution */
  onOutputsCaptured?: (outputs: OutputValues) => void
}

export interface UseApiExecReturn {
  state: ExecState
  execute: (
    executableId: string,
    variables?: Record<string, unknown>,
    envVars?: Record<string, string>,
    usePty?: boolean,
    timeoutMs?: number,
  ) => void
  cancel: () => void
  reset: () => void
}

// ---------------------------------------------------------------------------
// Execution IDs
// ---------------------------------------------------------------------------
// Every hook instance with a run in flight listens on the same exec:*
// channels. The main process puts the run's id on each event, and each
// listener drops the events of other runs. All instances share the counter so
// that ids don't repeat.
let execSeq = 0

/** Reports whether an exec:* event came from the run named `executionId`. */
function isEventOf(executionId: string, data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { executionId?: unknown }).executionId === executionId
  )
}

/**
 * Hook to execute scripts via IPC with streaming event listeners.
 * Uses executable IDs from the executable registry instead of raw script content.
 */
export function useApiExec(options?: UseApiExecOptions): UseApiExecReturn {
  const api = useApi()
  const [state, setState] = useState<ExecState>({
    logs: [],
    status: "pending",
    exitCode: null,
    error: null,
    outputs: null,
    logFilePath: null,
  })

  const cleanupRef = useRef<(() => void) | null>(null)
  const executionGenRef = useRef(0)
  // The id of the currently-running execution, or null when nothing is running.
  // Tracked independently of `cleanupRef` (the IPC listeners) so that Stop can
  // still cancel a run whose listeners have already been detached — and so the
  // decision to cancel doesn't depend on listener lifecycle timing.
  const runningExecIdRef = useRef<string | null>(null)
  // The last execution id this hook started, kept even after `exec:run`
  // resolves. `runningExecIdRef` is cleared the moment the invoke settles, but
  // a run aborted by the main process settles while its child may still be
  // winding down — and while the UI still shows "running". Falling back to this
  // id keeps Stop working in that window. It always names THIS hook's own run,
  // never "whatever ran last", so Stop can't reach into another block's script.
  const lastExecIdRef = useRef<string | null>(null)
  // Set when this hook asked for the cancellation, so the completion handler
  // doesn't explain the stop a second time (cancel() already logged it).
  const selfCancelledRef = useRef(false)

  const cancel = useCallback(() => {
    const execId = runningExecIdRef.current ?? lastExecIdRef.current
    selfCancelledRef.current = true

    // Signal the backend to interrupt + kill *this* run's child process group.
    // Cancelling a run the main process has already finished with is a no-op
    // there (the id is dropped when the handler returns), so it's safe to send
    // whenever we have one.
    if (execId !== null) {
      api.invoke("exec:cancel", { executionId: execId }).catch(() => {})
      runningExecIdRef.current = null
    }

    // Clean up IPC event subscriptions
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }

    // Log the cancellation only when the block was actually showing a run in
    // progress. Keyed on the rendered status rather than the id bookkeeping,
    // so a stuck-looking block reports the stop and an idle one stays quiet.
    setState((prev) =>
      prev.status === "running"
        ? {
            ...prev,
            status: "pending",
            logs: [...prev.logs, createLogEntry("Execution cancelled by user")],
          }
        : prev,
    )
  }, [api])

  const reset = useCallback(() => {
    cancel()
    setState({
      logs: [],
      status: "pending",
      exitCode: null,
      error: null,
      outputs: null,
      logFilePath: null,
    })
  }, [cancel])

  // Runs a registry executable over IPC and streams its events into state
  const executeScript = useCallback(
    async (payload: {
      executableId: string
      templateVarValues: Record<string, unknown>
      envVarsOverride?: Record<string, string>
      usePty?: boolean
      timeoutMs?: number
    }) => {
      // Cancel any existing execution and bump generation
      cancel()
      const generation = ++executionGenRef.current

      // Sent to the backend, which puts it on the run's events and cancels by
      // it. Held in a ref for cancel() to read.
      const executionId = String(++execSeq)
      runningExecIdRef.current = executionId
      lastExecIdRef.current = executionId
      selfCancelledRef.current = false

      // Reset state for new execution
      setState({
        logs: [],
        status: "running",
        exitCode: null,
        error: null,
        outputs: null,
        logFilePath: null,
      })

      // Subscribe to IPC streaming events before starting execution.
      const unsubs: (() => void)[] = []

      unsubs.push(
        api.on("exec:log", (data: unknown) => {
          if (!isEventOf(executionId, data)) return
          const parsed = ExecLogEventSchema.safeParse(data)
          if (parsed.success) {
            const newEntry = createLogEntry(parsed.data.line, parsed.data.timestamp)
            setState((prev) => ({
              ...prev,
              logs:
                parsed.data.replace && prev.logs.length > 0
                  ? [...prev.logs.slice(0, -1), newEntry]
                  : [...prev.logs, newEntry],
            }))
          }
        }),
      )

      unsubs.push(
        api.on("exec:log-file", (data: unknown) => {
          if (!isEventOf(executionId, data)) return
          const parsed = ExecLogFileEventSchema.safeParse(data)
          if (parsed.success) {
            setState((prev) => ({ ...prev, logFilePath: parsed.data.path }))
          }
        }),
      )

      unsubs.push(
        api.on("exec:outputs", (data: unknown) => {
          if (!isEventOf(executionId, data)) return
          const parsed = BlockOutputsEventSchema.safeParse(data)
          if (parsed.success) {
            setState((prev) => ({ ...prev, outputs: parsed.data.outputs }))
            options?.onOutputsCaptured?.(parsed.data.outputs)
          }
        }),
      )

      unsubs.push(
        api.on("exec:files-captured", (data: unknown) => {
          if (!isEventOf(executionId, data)) return
          const parsed = FilesCapturedEventSchema.safeParse(data)
          if (parsed.success) {
            options?.onFilesCaptured?.(parsed.data)
          }
        }),
      )

      unsubs.push(
        api.on("exec:status", (data: unknown) => {
          if (!isEventOf(executionId, data)) return
          const parsed = ExecStatusEventSchema.safeParse(data)
          if (parsed.success) {
            setState((prev) => ({
              ...prev,
              status: parsed.data.status as ExecState["status"],
              exitCode: parsed.data.exitCode ?? null,
            }))
          }
        }),
      )

      const cleanup = () => {
        for (const unsub of unsubs) unsub()
      }
      cleanupRef.current = cleanup

      try {
        const result = await api.invoke("exec:run", { ...payload, executionId })
        // The invoke resolved — this run is finished and no longer cancellable.
        if (generation === executionGenRef.current) {
          runningExecIdRef.current = null

          // Reconcile the final status from the invoke's return value. The streamed
          // `exec:status` event can be silently dropped, when listeners get detached
          // or the main process suppressed sends after an abort, which would otherwise
          // leave a *finished* block stuck showing
          // "running". The invoke result is the source of truth, so apply it whenever
          // the UI is still in a non-terminal state.
          if (result?.status) {
            const finalStatus = result.status
            setState((prev) =>
              prev.status === "running" || prev.status === "pending"
                ? {
                    ...prev,
                    status: finalStatus.status as ExecState["status"],
                    exitCode: finalStatus.exitCode,
                  }
                : prev,
            )
          } else {
            // No status means the main process aborted the run and resolved it
            // as { status: null, cancelled: true }. It sends no `exec:status`
            // after an abort, so without this the block would show "running"
            // forever. cancel() has already logged a stop this hook asked for.
            // A stop from the app quitting or the window reloading is logged
            // here.
            const explain = !selfCancelledRef.current
            setState((prev) =>
              prev.status === "running" || prev.status === "pending"
                ? {
                    ...prev,
                    status: "pending",
                    logs: explain
                      ? [...prev.logs, createLogEntry("Execution stopped before it finished.")]
                      : prev.logs,
                  }
                : prev,
            )
          }
        }
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
          runningExecIdRef.current = null
          const errorMessage = error instanceof Error ? error.message : "Unknown error"
          setState((prev) => ({
            ...prev,
            status: "fail",
            error: createAppError(
              "An unexpected error occurred while executing the script",
              errorMessage,
            ),
            logs: [...prev.logs, createLogEntry(`Error: ${errorMessage}`)],
          }))
          // Clean up listeners on error (no more events expected)
          cleanup()
          cleanupRef.current = null
        }
      }
    },
    [api, cancel, options],
  )

  // Execute script by executable ID
  const execute = useCallback(
    (
      executableId: string,
      templateVarValues: Record<string, unknown> = {},
      envVarsOverride?: Record<string, string>,
      usePty?: boolean,
      timeoutMs?: number,
    ) => {
      void executeScript(
        omitUndefined({
          executableId,
          templateVarValues,
          envVarsOverride,
          usePty,
          timeoutMs,
        }),
      )
    },
    [executeScript],
  )

  return {
    state,
    execute,
    cancel,
    reset,
  }
}
