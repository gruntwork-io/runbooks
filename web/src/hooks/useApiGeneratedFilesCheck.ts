import { useApi } from './useApi';
import { useServiceCall } from './useServiceCall';
import type { UseApiReturn } from './useApi';
import * as GeneratedFilesService from '@/bindings/github.com/gruntwork-io/runbooks/services/generatedfilesservice';
import { isDesktop } from '@/lib/wails';

// Response from the generated files check API
export interface GeneratedFilesCheckResult {
  hasFiles: boolean;
  absoluteOutputPath: string;
  relativeOutputPath: string;
  fileCount: number;
}

// Returns info about the output directory — whether it has files, how
// many, and the absolute path it resolved to. Desktop mode goes
// through Wails IPC; browser mode keeps hitting the Gin endpoint.
export function useApiGeneratedFilesCheck(): UseApiReturn<GeneratedFilesCheckResult> {
  const httpResult = useApi<GeneratedFilesCheckResult>(
    !isDesktop() ? '/api/generated-files/check' : '',
    'GET',
  );

  const ipcResult = useServiceCall<GeneratedFilesCheckResult>(
    async () => {
      const res = await GeneratedFilesService.Check();
      if (!res) throw new Error('generated-files check returned empty');
      return { ...res };
    },
    [],
    { lazy: !isDesktop() },
  );

  return isDesktop() ? ipcResult : httpResult;
}
