import {
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
} from "react"
import type { ReactNode } from "react"
import { useApi, type RunbooksAPI } from "./ApiContext"
import { useGitWorkTree } from "./useGitWorkTree"
import { GitFileChangesContext, GitFileTreeContext } from "./WorkspaceGitDataContext.types"
import { useChangesPoller } from "./useChangesPoller"
import type { GitFileTreeContextType, WorkspaceTreeNode } from "./WorkspaceGitDataContext.types"

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
      <GitFileChangesContext.Provider value={changes}>{children}</GitFileChangesContext.Provider>
    </GitFileTreeContext.Provider>
  )
}

/**
 * Fetches the structure-only file tree for the active worktree. Re-fetches
 * when the worktree's path changes (dropping the previous tree, with a
 * spinner) or treeVersion bumps for the same path (silently).
 */
function useFileTree(
  api: RunbooksAPI,
  localPath: string | null,
  treeVersion: number,
): GitFileTreeContextType {
  const [tree, setTree] = useState<WorkspaceTreeNode[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [totalFiles, setTotalFiles] = useState(0)
  // Monotonic request counter: only the latest tree request may commit. IPC
  // calls can't be cancelled, so a slow walk of the previous worktree must not
  // land over the current worktree's tree.
  const seqRef = useRef(0)
  // The active worktree as of the latest commit, read after an await.
  const localPathRef = useRef(localPath)
  useLayoutEffect(() => {
    localPathRef.current = localPath
  }, [localPath])

  // The worktree path the tree state belongs to. When the active path changes
  // (a switch, 'Clone again' handing the role to another worktree, or a
  // re-clone into a new directory), drop the previous repo's tree during this
  // render, so no consumer shows, opens or lazy-expands it under the new path
  // while the new walk loads. The path often changes together with
  // treeVersion, which alone would make the refetch a silent one.
  const [treePath, setTreePath] = useState(localPath)
  if (treePath !== localPath) {
    setTreePath(localPath)
    setTree(null)
    setTotalFiles(0)
    setError(null)
    setIsLoading(localPath !== null)
  }

  // Starts a new request generation, so responses to earlier requests are dropped.
  const nextTreeSeq = useCallback(() => ++seqRef.current, [])

  const fetchTree = useCallback(
    async (path: string, silent = false) => {
      const seq = nextTreeSeq()

      // Only show loading spinner on initial fetch, not background refreshes
      if (!silent) {
        setIsLoading(true)
      }
      setError(null)

      try {
        const data = (await api.invoke("workspace:tree", {
          worktreePath: path,
        })) as unknown as WorkspaceTreeResponse
        if (seq !== seqRef.current) return
        setTree(data.tree)
        setTotalFiles(data.totalFiles)
      } catch (err) {
        if (seq !== seqRef.current) return
        setError(err instanceof Error ? err.message : "Failed to load file tree")
        setTree(null)
        setTotalFiles(0)
      } finally {
        // A superseded request must not clear the spinner of the one that replaced it
        if (seq === seqRef.current) setIsLoading(false)
      }
    },
    [api, nextTreeSeq],
  )

  // Fetch when active worktree changes (show spinner) or treeVersion bumps (silent refresh).
  // With no worktree, the path change already cleared the tree during render,
  // and the previous run's cleanup dropped its in-flight response.
  const prevTreeVersionRef = useRef(treeVersion)
  // Read, not a trigger: the fetch below updates `tree` itself.
  const hasTree = useEffectEvent(() => tree !== null)
  useEffect(() => {
    if (!localPath) return

    // If treeVersion changed but path didn't, this is a background refresh — skip the spinner.
    // A path change already cleared `tree` during render, so it always shows one.
    const silent = prevTreeVersionRef.current !== treeVersion && hasTree()
    prevTreeVersionRef.current = treeVersion

    void fetchTree(localPath, silent)

    return () => {
      nextTreeSeq()
    }
  }, [localPath, fetchTree, nextTreeSeq, treeVersion])

  const refetch = useCallback(() => {
    if (localPath) {
      void fetchTree(localPath)
    }
  }, [localPath, fetchTree])

  const fetchSubtree = useCallback(
    async (nodeId: string) => {
      if (!localPath) return
      const basePath = localPath.replace(/\/+$/, "")
      const subPath = nodeId.replace(/^\/+/, "")
      const absolutePath = `${basePath}/${subPath}`

      try {
        const data = (await api.invoke("workspace:tree", {
          worktreePath: absolutePath,
        })) as unknown as WorkspaceTreeResponse
        // The user switched worktrees while this folder loaded. Node ids are
        // repo-relative, so merging now could graft this repo's children onto a
        // same-named folder (e.g. node_modules) in the other repo's tree.
        if (localPathRef.current !== localPath) return
        const prefixed = prefixTreeIds(data.tree, nodeId)

        setTree((prev) => {
          if (!prev) return prev
          return mergeSubtree(prev, nodeId, prefixed)
        })
      } catch (err) {
        console.error(`Failed to fetch subtree for "${nodeId}":`, err)
      }
    },
    [api, localPath],
  )

  return useMemo(
    () => ({ tree, isLoading, error, totalFiles, refetch, fetchSubtree }),
    [tree, isLoading, error, totalFiles, refetch, fetchSubtree],
  )
}

/**
 * Recursively find a node by ID and replace its children, clearing isLazyLoad.
 */
function mergeSubtree(
  nodes: WorkspaceTreeNode[],
  targetId: string,
  children: WorkspaceTreeNode[],
): WorkspaceTreeNode[] {
  return nodes.map((node) => {
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
  return nodes.map((node) => {
    const id = `${prefix}/${node.id}`
    return node.children
      ? { ...node, id, children: prefixTreeIds(node.children, prefix) }
      : { ...node, id }
  })
}
