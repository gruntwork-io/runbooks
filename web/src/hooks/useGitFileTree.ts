import { useState, useEffect, useCallback, useRef } from 'react'
import { useGitWorkTree } from '../contexts/useGitWorkTree'

/**
 * A workspace tree node (structure only, no content).
 */
export interface WorkspaceTreeNode {
  id: string
  name: string
  type: 'file' | 'folder'
  size?: number
  language?: string
  isBinary?: boolean
  isIgnored?: boolean
  isLazyLoad?: boolean
  children?: WorkspaceTreeNode[]
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

interface UseGitFileTreeResult {
  tree: WorkspaceTreeNode[] | null
  isLoading: boolean
  error: string | null
  totalFiles: number
  refetch: () => void
  /** Fetch children for a lazy-loaded folder and merge them into the tree. */
  fetchSubtree: (nodeId: string) => Promise<void>
}

/**
 * Hook that fetches the structure-only file tree for the active git worktree.
 * Re-fetches automatically when the active worktree changes.
 */
export function useGitFileTree(): UseGitFileTreeResult {
  const { activeWorkTree, treeVersion } = useGitWorkTree()
  const [tree, setTree] = useState<WorkspaceTreeNode[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalFiles, setTotalFiles] = useState(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  const fetchTree = useCallback(async (localPath: string, silent = false) => {
    // Abort any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const controller = new AbortController()
    abortControllerRef.current = controller

    // Only show loading spinner on initial fetch, not background refreshes
    if (!silent) {
      setIsLoading(true)
    }
    setError(null)

    try {
      const data = await window.api.invoke('workspace:tree', { worktreePath: localPath }) as unknown as WorkspaceTreeResponse
      setTree(data.tree)
      setTotalFiles(data.totalFiles)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return // Ignore aborted requests
      }
      setError(err instanceof Error ? err.message : 'Failed to load file tree')
      setTree(null)
      setTotalFiles(0)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Fetch when active worktree changes (show spinner) or treeVersion bumps (silent refresh)
  const prevTreeVersionRef = useRef(treeVersion)
  useEffect(() => {
    if (!activeWorkTree) {
      setTree(null)
      setTotalFiles(0)
      setError(null)
      return
    }

    // If treeVersion changed but path didn't, this is a background refresh — skip the spinner
    const silent = prevTreeVersionRef.current !== treeVersion && tree !== null
    prevTreeVersionRef.current = treeVersion

    fetchTree(activeWorkTree.localPath, silent)

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately exclude `activeWorkTree` (only need path) and `tree` (only read for silent check)
  }, [activeWorkTree?.localPath, fetchTree, treeVersion])

  const refetch = useCallback(() => {
    if (activeWorkTree) {
      fetchTree(activeWorkTree.localPath)
    }
  }, [activeWorkTree, fetchTree])

  const fetchSubtree = useCallback(async (nodeId: string) => {
    if (!activeWorkTree) return
    const basePath = activeWorkTree.localPath.replace(/\/+$/, '')
    const subPath = nodeId.replace(/^\/+/, '')
    const absolutePath = `${basePath}/${subPath}`

    try {
      const data = await window.api.invoke('workspace:tree', { worktreePath: absolutePath }) as unknown as WorkspaceTreeResponse
      const prefixed = prefixTreeIds(data.tree, nodeId)

      setTree(prev => {
        if (!prev) return prev
        return mergeSubtree(prev, nodeId, prefixed)
      })
    } catch (err) {
      console.error(`Failed to fetch subtree for "${nodeId}":`, err)
    }
  }, [activeWorkTree])

  return { tree, isLoading, error, totalFiles, refetch, fetchSubtree }
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
