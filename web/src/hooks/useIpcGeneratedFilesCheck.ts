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
 */
export function useIpcGeneratedFilesCheck(
  options?: { disabled?: boolean },
): UseIpcReturn<GeneratedFilesCheckResult> {
  return useIpc<GeneratedFilesCheckResult>('generated-files:check', undefined, options)
}
