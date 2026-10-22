import { useIpc } from "./useIpc"
import type { UseIpcReturn } from "./useIpc"
import type { FileTreeResponse } from "@/contexts/GeneratedFilesContext.types"

/**
 * Response from the generated files check IPC channel. When the directory has
 * files, it also has their tree (the FileTreeResponse fields).
 */
export interface GeneratedFilesCheckResult extends Partial<FileTreeResponse> {
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
 * `sessionKey` is only a cache key: the check re-runs whenever the open
 * runbook or its session changes (the handler ignores the field and checks
 * the session's output directory). Don't use `refetch` for this — it ignores
 * `disabled`.
 */
export function useIpcGeneratedFilesCheck(options?: {
  disabled?: boolean | undefined
  sessionKey?: string | undefined
}): UseIpcReturn<GeneratedFilesCheckResult> {
  return useIpc<GeneratedFilesCheckResult>(
    "generated-files:check",
    options?.sessionKey ? { sessionKey: options.sessionKey } : undefined,
    { disabled: options?.disabled },
  )
}
