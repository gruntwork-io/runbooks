import { useState, useEffect, useCallback, useRef } from 'react'
import { useGitWorkTree } from '../contexts/useGitWorkTree'
import { useSession } from '../contexts/useSession'

/**
 * A file change in the workspace (from git status + diff).
 */
export interface WorkspaceFileChange {
  path: string
  changeType: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
  originalContent?: string
  newContent?: string
  language: string
  isBinary?: boolean
  diffTruncated?: boolean
  sourceBlockId?: string
  sourceBlockType?: string
}

interface WorkspaceChangesResponse {
  changes: WorkspaceFileChange[]
  totalChanges: number
  tooManyChanges?: boolean
}

interface UseWorkspaceChangesResult {
  changes: WorkspaceFileChange[]
  totalChanges: number
  tooManyChanges: boolean
  isLoading: boolean
  /** Fetch the full diff for a single file that was truncated */
  fetchFileDiff: (filePath: string) => Promise<void>
}

const POLL_INTERVAL_MS = 3000

/**
 * Hook that polls for git changes in the active worktree.
 * Polls every 3 seconds, skips if the previous request is still in-flight.
 */
export function useWorkspaceChanges(): UseWorkspaceChangesResult {
  const { activeWorkTree, treeVersion } = useGitWorkTree()
  const { getAuthHeader } = useSession()
  const [changes, setChanges] = useState<WorkspaceFileChange[]>([])
  const [totalChanges, setTotalChanges] = useState(0)
  const [tooManyChanges, setTooManyChanges] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const inFlightRef = useRef(false)
  const previousResponseRef = useRef<string>('')

  const fetchChanges = useCallback(async (localPath: string) => {
    if (inFlightRef.current) return // Skip if previous request is in-flight
    inFlightRef.current = true

    try {
      const response = await fetch(
        `/api/workspace/changes?path=${encodeURIComponent(localPath)}`,
        { headers: { ...getAuthHeader() } }
      )

      if (!response.ok) {
        return // Silently retry on next interval
      }

      const text = await response.text()

      // Smart skipping: don't update state if response is identical
      if (text === previousResponseRef.current) {
        return
      }
      previousResponseRef.current = text

      const data: WorkspaceChangesResponse = JSON.parse(text)
      setChanges(data.changes || [])
      setTotalChanges(data.totalChanges)
      setTooManyChanges(data.tooManyChanges ?? false)
    } catch {
      // Silently retry on next interval
    } finally {
      inFlightRef.current = false
    }
  }, [getAuthHeader])

  // Poll for changes, and refetch immediately when treeVersion changes
  useEffect(() => {
    if (!activeWorkTree) {
      setChanges([])
      setTotalChanges(0)
      setTooManyChanges(false)
      previousResponseRef.current = ''
      return
    }

    // Clear cache so the next fetch isn't skipped by smart-dedup
    previousResponseRef.current = ''

    setIsLoading(true)
    const localPath = activeWorkTree.localPath

    // Fetch immediately on mount / worktree change / tree invalidation
    fetchChanges(localPath).then(() => setIsLoading(false))

    const interval = setInterval(() => {
      fetchChanges(localPath)
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      previousResponseRef.current = ''
    }
  }, [activeWorkTree?.localPath, fetchChanges, treeVersion])

  const fetchFileDiff = useCallback(async (filePath: string) => {
    if (!activeWorkTree) return

    try {
      const response = await fetch(
        `/api/workspace/changes?path=${encodeURIComponent(activeWorkTree.localPath)}&file=${encodeURIComponent(filePath)}`,
        { headers: { ...getAuthHeader() } }
      )

      if (!response.ok) return

      const data: WorkspaceChangesResponse = await response.json()
      if (data.changes && data.changes.length > 0) {
        const fullChange = data.changes[0]
        // Merge the full diff into the existing changes array
        setChanges(prev =>
          prev.map(c =>
            c.path === filePath
              ? { ...c, originalContent: fullChange.originalContent, newContent: fullChange.newContent, diffTruncated: false }
              : c
          )
        )
      }
    } catch {
      // Silently fail
    }
  }, [activeWorkTree, getAuthHeader])

  return { changes, totalChanges, tooManyChanges, isLoading, fetchFileDiff }
}
