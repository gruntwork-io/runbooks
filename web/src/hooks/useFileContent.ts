import { useState, useCallback, useRef } from 'react'

interface FileContentResult {
  path: string
  content?: string
  language: string
  size: number
  isImage?: boolean
  mimeType?: string
  dataUri?: string
  isBinary?: boolean
  isTooLarge?: boolean
}

interface UseFileContentResult {
  /** Fetch content for a file. Results are cached in memory. */
  fetchFileContent: (filePath: string) => Promise<FileContentResult | null>
  /** Refetch content for a file, bypassing cache. Use when the file may have changed on disk. */
  refetchFileContent: (filePath: string) => Promise<FileContentResult | null>
  /** Clear the entire cache so the next fetch for any file hits the server. */
  clearCache: () => void
  /** Currently loaded file content */
  fileContent: FileContentResult | null
  /** Whether a fetch is in progress */
  isLoading: boolean
  /** Error message if the last fetch failed */
  error: string | null
}

const MAX_CACHE_SIZE = 50

/**
 * Hook for lazy-loading individual file content from the workspace.
 * Includes an in-memory LRU cache (max 50 entries).
 */
export function useFileContent(): UseFileContentResult {
  const [fileContent, setFileContent] = useState<FileContentResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cacheRef = useRef<Map<string, FileContentResult>>(new Map())

  const doFetch = useCallback(async (filePath: string, bypassCache: boolean): Promise<FileContentResult | null> => {
    const cache = cacheRef.current
    if (!bypassCache && cache.has(filePath)) {
      const cached = cache.get(filePath)!
      cache.delete(filePath)
      cache.set(filePath, cached)
      setFileContent(cached)
      setError(null)
      return cached
    }

    if (bypassCache) {
      cache.delete(filePath)
    }

    setIsLoading(true)
    setError(null)

    try {
      const data: FileContentResult = await window.api.invoke('workspace:file', { worktreePath: '.', filePath }) as unknown as FileContentResult

      if (cache.size >= MAX_CACHE_SIZE) {
        const oldestKey = cache.keys().next().value
        if (oldestKey !== undefined) {
          cache.delete(oldestKey)
        }
      }
      cache.set(filePath, data)

      setFileContent(data)
      return data
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file'
      setError(message)
      setFileContent(null)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchFileContent = useCallback((filePath: string) => doFetch(filePath, false), [doFetch])
  const refetchFileContent = useCallback((filePath: string) => doFetch(filePath, true), [doFetch])
  const clearCache = useCallback(() => { cacheRef.current.clear() }, [])

  return { fetchFileContent, refetchFileContent, clearCache, fileContent, isLoading, error }
}
