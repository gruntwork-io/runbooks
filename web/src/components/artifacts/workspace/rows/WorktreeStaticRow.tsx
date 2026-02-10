/**
 * @fileoverview WorktreeStaticRow Component
 *
 * Static single-repo row showing owner/name, branch, and short SHA.
 * Used when there is only one worktree (no switcher needed).
 */

import { GitBranch } from 'lucide-react'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import type { GitRepoInfo } from '@/types/workspace'

export function WorktreeStaticRow({ gitInfo }: { gitInfo: GitRepoInfo }) {
  const repoHref = gitInfo.repoUrl.startsWith('http')
    ? gitInfo.repoUrl
    : `https://${gitInfo.repoUrl}`

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <GitHubIcon className="w-4 h-4 text-gray-500 flex-shrink-0" />
      <a
        href={repoHref}
        target="_blank"
        rel="noopener noreferrer"
        className="text-gray-800 font-medium hover:text-blue-600 hover:underline truncate"
      >
        {gitInfo.repoOwner}/{gitInfo.repoName}
      </a>
      <span className="text-gray-300 text-xs">|</span>
      <div className="flex items-center gap-1 text-xs">
        <GitBranch className="w-3.5 h-3.5 text-gray-500" />
        <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">
          {gitInfo.branch}
        </span>
        {gitInfo.commitSha && (
          <span className="font-mono text-gray-500">
            {gitInfo.commitSha.slice(0, 7)}
          </span>
        )}
      </div>
    </div>
  )
}
