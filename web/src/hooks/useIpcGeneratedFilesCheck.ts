import { useIpc } from './useIpc'
import type { UseIpcReturn } from './useIpc'

/**
 * Response from the generated files check IPC channel
 */
export interface GeneratedFilesCheckResult {
  hasFiles: boolean
  absoluteOutputPath: string
  relativeOutputPath: string
  fileCount: number
}

/**
 * IPC hook to check if generated files exist in the output directory.
 *
 * The underlying `generated-files:check` handler requires an active session
 * (created when a runbook is opened), so callers should disable this hook
 * until a runbook has loaded to avoid SessionNotFoundError.
 *
 * `runbookPath` is only a cache key: the check re-runs whenever the open
 * runbook changes (the handler ignores the field and checks the session's
 * output directory). Don't use `refetch` for this — it ignores `disabled`.
 */
export function useIpcGeneratedFilesCheck(
  options?: { disabled?: boolean; runbookPath?: string },
): UseIpcReturn<GeneratedFilesCheckResult> {
  return useIpc<GeneratedFilesCheckResult>(
    'generated-files:check',
    options?.runbookPath ? { runbookPath: options.runbookPath } : undefined,
    { disabled: options?.disabled },
  )
}
