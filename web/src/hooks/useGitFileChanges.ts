import { useState, useEffect, useCallback, useRef } from 'react'
import { useGitWorkTree } from '../contexts/useGitWorkTree'
import { useSession } from '../contexts/useSession'
import * as WorkspaceService from '@/bindings/github.com/gruntwork-io/runbooks/services/workspaceservice'
import { isDesktop } from '@/lib/wails'

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

interface UseGitFileChangesResult {
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
export function useGitFileChanges(): UseGitFileChangesResult {
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
      let data: WorkspaceChangesResponse
      let key: string
      if (isDesktop()) {
        const res = await WorkspaceService.Changes(localPath, '')
        if (!res) return
        data = { ...res } as WorkspaceChangesResponse
        key = JSON.stringify(data)
      } else {
        const response = await fetch(
          `/api/workspace/changes?path=${encodeURIComponent(localPath)}`,
          { headers: { ...getAuthHeader() } }
        )

        if (!response.ok) {
          return // Silently retry on next interval
        }

        key = await response.text()
        data = JSON.parse(key)
      }

      // Smart skipping: don't update state if response is identical
      if (key === previousResponseRef.current) {
        return
      }
      previousResponseRef.current = key

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the path changes, not the full object
  }, [activeWorkTree?.localPath, fetchChanges, treeVersion])

  const fetchFileDiff = useCallback(async (filePath: string) => {
    if (!activeWorkTree) return

    try {
      let data: WorkspaceChangesResponse
      if (isDesktop()) {
        const res = await WorkspaceService.Changes(activeWorkTree.localPath, filePath)
        if (!res) return
        data = { ...res } as WorkspaceChangesResponse
      } else {
        const response = await fetch(
          `/api/workspace/changes?path=${encodeURIComponent(activeWorkTree.localPath)}&file=${encodeURIComponent(filePath)}`,
          { headers: { ...getAuthHeader() } }
        )

        if (!response.ok) return

        data = await response.json()
      }
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
