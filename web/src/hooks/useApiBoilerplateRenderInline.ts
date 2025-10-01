import { useCallback, useState } from 'react';
import { useFileTree } from './useFileTree';
import { mergeFileTrees } from '@/lib/mergeFileTrees';

// This is a custom hook for calling the backend API to render boilerplate templates that provide
// the template files in the request body instead of requiring them to be stored on disk.

interface BoilerplateRenderInlineResult {
  message: string;
  renderedFiles: Record<string, string>;
  fileTree: FileTree;
}

type FileTree = CodeFileData[]

interface CodeFileData {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: CodeFileData[];
  filePath: string;
  code: string;
  language: string;
  size: number;
}

// Return type for the hook
interface UseApiBoilerplateRenderInlineResult {
  data: BoilerplateRenderInlineResult | null;
  isLoading: boolean;
  error: { message: string; details?: string } | null;
  isAutoRendering: boolean;
  autoRender: (templateFiles: Record<string, string>, variables: Record<string, unknown>) => Promise<void>;
}

// Hook for rendering inline boilerplate templates
export function useApiBoilerplateRenderInline(): UseApiBoilerplateRenderInlineResult {
  const { fileTree, setFileTree } = useFileTree();  // The FileTree is where we render the list of generated files
  const [data, setData] = useState<BoilerplateRenderInlineResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);

  // Manual render function that calls the API directly
  const autoRender = useCallback(async (templateFiles: Record<string, string>, variables: Record<string, unknown>) => {
    if (!templateFiles || Object.keys(templateFiles).length === 0) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/boilerplate/render-inline', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ templateFiles, variables }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        setError({
          message: errorData?.error || 'Render failed',
          details: errorData?.details
        });
        setIsLoading(false);
        return;
      }

      const responseData = await response.json();
      setData(responseData);
      
      // Merge the new file tree with the existing one
      if (responseData?.fileTree && Array.isArray(responseData.fileTree)) {
        const mergedTree = mergeFileTrees(fileTree, responseData.fileTree);
        setFileTree(mergedTree);
      }
      
      setIsLoading(false);
    } catch (err) {
      setError({
        message: 'Failed to render template',
        details: err instanceof Error ? err.message : 'Unknown error'
      });
      setIsLoading(false);
    }
  }, [fileTree, setFileTree]);

  return {
    data,
    isLoading,
    error,
    isAutoRendering: isLoading,
    autoRender
  };
}

