/**
 * @fileoverview RepositoryMetadataBar Component
 *
 * Displays git repository info: either
 * - static repo/branch row, plus the local path, or
 * - worktree switcher (when 2+ worktrees)
 */

import { cn } from '@/lib/utils'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { WorktreeSwitcherRow } from './rows/WorktreeSwitcherRow'
import { WorktreeStaticRow } from './rows/WorktreeStaticRow'
import { LocalPathRow } from './rows/LocalPathRow'
import type { GitRepoInfo } from '@/types/workspace'
import type { GitWorkTree } from '@/contexts/GitWorkTreeContext'

interface RepositoryMetadataBarProps {
  /** Git repository information for the active worktree */
  gitInfo: GitRepoInfo | null;
  /** Local path where files are downloaded */
  localPath?: string;
  /** When 2+ worktrees, the bar shows a dropdown switcher instead of static repo/branch */
  workTrees?: GitWorkTree[];
  activeWorkTreeId?: string | null;
  onWorktreeSelect?: (id: string) => void;
  /** Additional CSS classes */
  className?: string;
}

export const RepositoryMetadataBar = ({
  gitInfo,
  localPath,
  workTrees = [],
  activeWorkTreeId = null,
  onWorktreeSelect,
  className = "",
}: RepositoryMetadataBarProps) => {
  const hasSwitcher = workTrees.length >= 2 && onWorktreeSelect

  // No repo and no path: minimal state or nothing
  if (!gitInfo && !localPath) {
    if (!hasSwitcher) {
      return (
        <div className={cn("py-2.5 text-sm", className)}>
          <div className="flex items-center gap-2 text-gray-500">
            <GitHubIcon className="w-4 h-4" />
            <span className="italic">No repository connected</span>
          </div>
        </div>
      )
    }
    // Switcher only — very unlikely edge case: 2+ worktrees exist but the
    // active one has no gitInfo and no localPath (e.g. a clone is still in
    // progress or failed). We still render the dropdown so the user can
    // switch to a different worktree.
    return (
      <div className={cn("py-2.5", className)}>
        <WorktreeSwitcherRow
          workTrees={workTrees}
          activeWorkTreeId={activeWorkTreeId}
          onSelect={onWorktreeSelect}
        />
      </div>
    )
  }

  return (
    <div className={cn("py-2.5", className)}>
      {/* Row 1: worktree switcher (2+ worktrees) or static repo/branch */}
      {hasSwitcher ? (
        <WorktreeSwitcherRow
          workTrees={workTrees}
          activeWorkTreeId={activeWorkTreeId}
          onSelect={onWorktreeSelect}
        />
      ) : gitInfo ? (
        <WorktreeStaticRow gitInfo={gitInfo} />
      ) : null}

      {/* Row 2: Local path */}
      {localPath && (
        <LocalPathRow
          displayText={`./${localPath.split('/').pop()}`}
          copyPath={localPath}
          className={(hasSwitcher || gitInfo) ? "mt-1.5" : undefined}
        />
      )}
    </div>
  )
}
