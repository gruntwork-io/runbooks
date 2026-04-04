import { useState, useEffect, useCallback, useRef } from 'react'
import { useGitWorkTree } from '@/contexts/useGitWorkTree'
import { useApi } from '@/contexts/ApiContext'

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

interface UseIpcGitFileChangesResult {
  changes: WorkspaceFileChange[]
  totalChanges: number
  tooManyChanges: boolean
  isLoading: boolean
  /** Fetch the full diff for a single file that was truncated */
  fetchFileDiff: (filePath: string) => Promise<void>
}

const POLL_INTERVAL_MS = 3000

/**
 * IPC hook that polls for git changes in the active worktree.
 * Polls every 3 seconds, skips if the previous request is still in-flight.
 * Replaces useGitFileChanges which used HTTP GET /api/workspace/changes.
 */
export function useIpcGitFileChanges(): UseIpcGitFileChangesResult {
  const { activeWorkTree, treeVersion } = useGitWorkTree()
  const api = useApi()
  const [changes, setChanges] = useState<WorkspaceFileChange[]>([])
  const [totalChanges, setTotalChanges] = useState(0)
  const [tooManyChanges, setTooManyChanges] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const inFlightRef = useRef(false)
  const previousResponseRef = useRef<string>('')

  const fetchChanges = useCallback(async (localPath: string) => {
    if (inFlightRef.current) return
    inFlightRef.current = true

    try {
      const data = await api.invoke<WorkspaceChangesResponse>('workspace:changes', { path: localPath })
      const text = JSON.stringify(data)

      // Smart skipping: don't update state if response is identical
      if (text === previousResponseRef.current) {
        return
      }
      previousResponseRef.current = text

      setChanges(data.changes || [])
      setTotalChanges(data.totalChanges)
      setTooManyChanges(data.tooManyChanges ?? false)
    } catch {
      // Silently retry on next interval
    } finally {
      inFlightRef.current = false
    }
  }, [api])

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
      const data = await api.invoke<WorkspaceChangesResponse>(
        'workspace:changes',
        { path: activeWorkTree.localPath, file: filePath }
      )
      if (data.changes && data.changes.length > 0) {
        const fullChange = data.changes[0]
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
  }, [activeWorkTree, api])

  return { changes, totalChanges, tooManyChanges, isLoading, fetchFileDiff }
}
