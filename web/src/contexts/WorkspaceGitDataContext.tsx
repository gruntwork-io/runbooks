import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { useApi, type RunbooksAPI } from './ApiContext'
import { useGitWorkTree } from './useGitWorkTree'
import { GitFileChangesContext, GitFileTreeContext } from './WorkspaceGitDataContext.types'
import type {
  GitFileChangesContextType,
  GitFileTreeContextType,
  WorkspaceFileChange,
  WorkspaceTreeNode,
} from './WorkspaceGitDataContext.types'

interface WorkspaceChangesResponse {
  changes: WorkspaceFileChange[]
  totalChanges: number
  tooManyChanges?: boolean
}

interface WorkspaceGitInfo {
  branch: string
  remoteUrl: string
  commitSha: string
}

interface WorkspaceTreeResponse {
  tree: WorkspaceTreeNode[]
  totalFiles: number
  gitInfo?: WorkspaceGitInfo
}

const POLL_INTERVAL_MS = 3000

interface WorkspaceGitDataProviderProps {
  children: ReactNode
}

/**
 * Owns the git data shown for the active worktree: the changed-files poller
 * and the structure-only file tree. Read it with useGitFileChanges() and
 * useGitFileTree().
 *
 * Mounted once at the app root (main.tsx), so both ArtifactsContainer layouts,
 * the "All files" browser and every PR block share one `workspace:changes`
 * poll and one `workspace:tree` walk, and all of them show the same snapshot.
 */
export const WorkspaceGitDataProvider: React.FC<WorkspaceGitDataProviderProps> = ({ children }) => {
  const api = useApi()
  const { activeWorkTree, treeVersion } = useGitWorkTree()
  const localPath = activeWorkTree?.localPath ?? null

  const changes = useChangesPoller(api, localPath, treeVersion)
  const tree = useFileTree(api, localPath, treeVersion)

  // Refresh the file tree whenever the number of changed files changes
  // (files may have been added or deleted).
  const { totalChanges } = changes
  const { refetch: refetchTree } = tree
  const prevTotalChangesRef = useRef(totalChanges)
  useEffect(() => {
    if (totalChanges === prevTotalChangesRef.current) return
    prevTotalChangesRef.current = totalChanges
    refetchTree()
  }, [totalChanges, refetchTree])

  return (
    <GitFileTreeContext.Provider value={tree}>
      <GitFileChangesContext.Provider value={changes}>
        {children}
      </GitFileChangesContext.Provider>
    </GitFileTreeContext.Provider>
  )
}

/**
 * Polls for git changes in the active worktree every 3 seconds, and refetches
 * immediately when the worktree switches or treeVersion bumps.
 */
function useChangesPoller(api: RunbooksAPI, localPath: string | null, treeVersion: number): GitFileChangesContextType {
  const [changes, setChanges] = useState<WorkspaceFileChange[]>([])
  const [totalChanges, setTotalChanges] = useState(0)
  const [tooManyChanges, setTooManyChanges] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  // Bumped on every run of the poll effect (worktree switch or tree
  // invalidation). IPC calls can't be cancelled, so a response that belongs to
  // an earlier run is dropped rather than committed over the current state.
  const genRef = useRef(0)
  // Generation whose request is in flight. Interval ticks skip while their own
  // run's request is outstanding, but a new run's immediate fetch never waits
  // on an older run's request.
  const inFlightGenRef = useRef<number | null>(null)
  const previousResponseRef = useRef<string>('')

  const fetchChanges = useCallback(async (path: string, gen: number) => {
    if (inFlightGenRef.current === gen) return // Skip if this run's previous request is in-flight
    inFlightGenRef.current = gen

    try {
      const data = await api.invoke('workspace:changes', { worktreePath: path }) as unknown as WorkspaceChangesResponse
      if (gen !== genRef.current) return // Superseded by a worktree switch or tree invalidation

      // Smart skipping: don't update state if response is identical
      const text = JSON.stringify(data)
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
      if (inFlightGenRef.current === gen) inFlightGenRef.current = null
    }
  }, [api])

  // Poll for changes, and refetch immediately when treeVersion changes
  useEffect(() => {
    const gen = ++genRef.current
    // Clear cache so the next fetch isn't skipped by smart-dedup
    previousResponseRef.current = ''

    if (!localPath) {
      setChanges([])
      setTotalChanges(0)
      setTooManyChanges(false)
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    // Fetch immediately on mount / worktree change / tree invalidation
    fetchChanges(localPath, gen).then(() => {
      if (gen === genRef.current) setIsLoading(false)
    })

    const interval = setInterval(() => {
      fetchChanges(localPath, gen)
    }, POLL_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [localPath, fetchChanges, treeVersion])

  const fetchFileDiff = useCallback(async (filePath: string) => {
    if (!localPath) return
    const gen = genRef.current

    try {
      const data = await api.invoke('workspace:changes', { worktreePath: localPath, singleFile: filePath }) as unknown as WorkspaceChangesResponse
      // The worktree switched or its files changed while the diff loaded; the
      // next poll has already replaced (or will replace) this entry.
      if (gen !== genRef.current) return
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
  }, [api, localPath])

  return useMemo(
    () => ({ changes, totalChanges, tooManyChanges, isLoading, fetchFileDiff }),
    [changes, totalChanges, tooManyChanges, isLoading, fetchFileDiff]
  )
}

/**
 * Fetches the structure-only file tree for the active worktree. Re-fetches
 * when the worktree switches (with a spinner) or treeVersion bumps (silently).
 */
function useFileTree(api: RunbooksAPI, localPath: string | null, treeVersion: number): GitFileTreeContextType {
  const [tree, setTree] = useState<WorkspaceTreeNode[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalFiles, setTotalFiles] = useState(0)
  // Monotonic request counter: only the latest tree request may commit. IPC
  // calls can't be cancelled, so a slow walk of the previous worktree must not
  // land over the current worktree's tree.
  const seqRef = useRef(0)
  // The active worktree as of the latest render, read after an await.
  const localPathRef = useRef(localPath)
  localPathRef.current = localPath

  const fetchTree = useCallback(async (path: string, silent = false) => {
    const seq = ++seqRef.current

    // Only show loading spinner on initial fetch, not background refreshes
    if (!silent) {
      setIsLoading(true)
    }
    setError(null)

    try {
      const data = await api.invoke('workspace:tree', { worktreePath: path }) as unknown as WorkspaceTreeResponse
      if (seq !== seqRef.current) return
      setTree(data.tree)
      setTotalFiles(data.totalFiles)
    } catch (err) {
      if (seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load file tree')
      setTree(null)
      setTotalFiles(0)
    } finally {
      // A superseded request must not clear the spinner of the one that replaced it
      if (seq === seqRef.current) setIsLoading(false)
    }
  }, [api])

  // Fetch when active worktree changes (show spinner) or treeVersion bumps (silent refresh)
  const prevTreeVersionRef = useRef(treeVersion)
  useEffect(() => {
    if (!localPath) {
      seqRef.current++ // Drop any response still in flight for the previous worktree
      setTree(null)
      setTotalFiles(0)
      setError(null)
      setIsLoading(false)
      return
    }

    // If treeVersion changed but path didn't, this is a background refresh — skip the spinner
    const silent = prevTreeVersionRef.current !== treeVersion && tree !== null
    prevTreeVersionRef.current = treeVersion

    fetchTree(localPath, silent)

    return () => {
      seqRef.current++
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `tree` is only read for the silent check
  }, [localPath, fetchTree, treeVersion])

  const refetch = useCallback(() => {
    if (localPath) {
      fetchTree(localPath)
    }
  }, [localPath, fetchTree])

  const fetchSubtree = useCallback(async (nodeId: string) => {
    if (!localPath) return
    const basePath = localPath.replace(/\/+$/, '')
    const subPath = nodeId.replace(/^\/+/, '')
    const absolutePath = `${basePath}/${subPath}`

    try {
      const data = await api.invoke('workspace:tree', { worktreePath: absolutePath }) as unknown as WorkspaceTreeResponse
      // The user switched worktrees while this folder loaded. Node ids are
      // repo-relative, so merging now could graft this repo's children onto a
      // same-named folder (e.g. node_modules) in the other repo's tree.
      if (localPathRef.current !== localPath) return
      const prefixed = prefixTreeIds(data.tree, nodeId)

      setTree(prev => {
        if (!prev) return prev
        return mergeSubtree(prev, nodeId, prefixed)
      })
    } catch (err) {
      console.error(`Failed to fetch subtree for "${nodeId}":`, err)
    }
  }, [api, localPath])

  return useMemo(
    () => ({ tree, isLoading, error, totalFiles, refetch, fetchSubtree }),
    [tree, isLoading, error, totalFiles, refetch, fetchSubtree]
  )
}

/**
 * Recursively find a node by ID and replace its children, clearing isLazyLoad.
 */
function mergeSubtree(
  nodes: WorkspaceTreeNode[],
  targetId: string,
  children: WorkspaceTreeNode[]
): WorkspaceTreeNode[] {
  return nodes.map(node => {
    if (node.id === targetId) {
      return { ...node, children, isLazyLoad: false }
    }
    if (node.children) {
      return { ...node, children: mergeSubtree(node.children, targetId, children) }
    }
    return node
  })
}

/**
 * Prefix all node IDs in a subtree so they're relative to the repo root.
 * The tree endpoint returns IDs relative to the queried directory, but the
 * main tree uses IDs relative to the repo root.
 */
function prefixTreeIds(nodes: WorkspaceTreeNode[], prefix: string): WorkspaceTreeNode[] {
  return nodes.map(node => ({
    ...node,
    id: `${prefix}/${node.id}`,
    children: node.children ? prefixTreeIds(node.children, prefix) : undefined,
  }))
}
