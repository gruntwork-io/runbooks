import { useApi } from './useApi';
import type { UseApiReturn } from './useApi';

/**
 * Response from the generated files check API
 */
export interface GeneratedFilesCheckResult {
  hasFiles: boolean;
  absoluteOutputPath: string;
  relativeOutputPath: string;
  fileCount: number;
}

/**
 * Hook to check if generated files exist in the output directory
 */
export function useApiGeneratedFilesCheck(): UseApiReturn<GeneratedFilesCheckResult> {
  return useApi<GeneratedFilesCheckResult>('/api/generated-files/check', 'GET');
}

