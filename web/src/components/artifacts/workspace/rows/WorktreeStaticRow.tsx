/**
 * @fileoverview WorktreeStaticRow Component
 *
 * Static single-repo row showing owner/name, ref, and short SHA.
 * Used when there is only one worktree (no switcher needed).
 */

import type { GitRepoInfo } from '@/types/workspace'
import { RefIcon, formatRef } from './gitRefDisplay'
import { RepoIcon, RepoLabel } from './RepoLabel'

export function WorktreeStaticRow({ gitInfo }: { gitInfo: GitRepoInfo }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <RepoIcon repoUrl={gitInfo.repoUrl} className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <RepoLabel gitInfo={gitInfo} asLink className="text-foreground font-medium truncate" />
      <span className="text-muted-foreground text-xs">|</span>
      <div className="flex items-center gap-1 text-xs">
        <RefIcon refType={gitInfo.refType} className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
          {formatRef(gitInfo.ref, gitInfo.refType)}
        </span>
        {gitInfo.commitSha && gitInfo.refType !== 'commit' && (
          <span className="font-mono text-muted-foreground">
            {gitInfo.commitSha.slice(0, 7)}
          </span>
        )}
      </div>
    </div>
  )
}
