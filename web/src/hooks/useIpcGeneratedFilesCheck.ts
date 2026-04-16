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
 */
export function useIpcGeneratedFilesCheck(): UseIpcReturn<GeneratedFilesCheckResult> {
  return useIpc<GeneratedFilesCheckResult>('generated-files:check')
}
