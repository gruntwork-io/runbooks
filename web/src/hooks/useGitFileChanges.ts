import { useContext } from "react"
import { useApi } from "../contexts/ApiContext"
import { useChangesPoller } from "../contexts/useChangesPoller"
import { useGitWorkTree } from "../contexts/useGitWorkTree"
import {
  GitFileChangesContext,
  type GitFileChangesContextType,
} from "../contexts/WorkspaceGitDataContext.types"

export type { WorkspaceFileChange } from "../contexts/WorkspaceGitDataContext.types"

/**
 * Git changes in the active worktree, polled every 3 seconds.
 *
 * The poller lives in WorkspaceGitDataProvider, so every caller shares one
 * `workspace:changes` request per interval and sees the same snapshot.
 */
export function useGitFileChanges(): GitFileChangesContextType {
  const context = useContext(GitFileChangesContext)
  if (context === undefined) {
    throw new Error("useGitFileChanges must be used within a WorkspaceGitDataProvider")
  }
  return context
}

/**
 * Git changes in the clone at `worktreePath`: the shared poll's when it's the
 * active worktree, otherwise a poll of its own, so a block bound to a clone
 * by `gitCloneId` sees that clone's changes whichever is active.
 */
export function useCloneChanges(worktreePath: string | undefined): GitFileChangesContextType {
  const shared = useGitFileChanges()
  const api = useApi()
  const { activeWorkTree, treeVersion } = useGitWorkTree()
  const isActive = worktreePath !== undefined && worktreePath === activeWorkTree?.localPath
  const own = useChangesPoller(api, isActive ? null : (worktreePath ?? null), treeVersion)
  return isActive ? shared : own
}
