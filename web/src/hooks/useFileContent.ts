import { useState, useCallback, useRef } from 'react'
import { useSession } from '../contexts/useSession'

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
  const { getAuthHeader } = useSession()
  const [fileContent, setFileContent] = useState<FileContentResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cacheRef = useRef<Map<string, FileContentResult>>(new Map())

  const fetchFileContent = useCallback(async (filePath: string): Promise<FileContentResult | null> => {
    // Check cache first
    const cache = cacheRef.current
    if (cache.has(filePath)) {
      const cached = cache.get(filePath)!
      // Move to end of map (most recently used)
      cache.delete(filePath)
      cache.set(filePath, cached)
      setFileContent(cached)
      setError(null)
      return cached
    }

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(
        `/api/workspace/file?path=${encodeURIComponent(filePath)}`,
        { headers: { ...getAuthHeader() } }
      )

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Failed to load file (${response.status})`)
      }

      const data: FileContentResult = await response.json()

      // Add to cache, evict oldest if at capacity
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
  }, [getAuthHeader])

  return { fetchFileContent, fileContent, isLoading, error }
}
