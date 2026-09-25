/**
 * Shared repo icon + label for the worktree rows (static + switcher), so both
 * agree on the provider icon, the owner/name text, and when to link out.
 */

import { FolderGit2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { GitLabIcon } from '@/components/icons/GitLabIcon'
import { deriveProviderFromRepoUrl, repoWebUrl } from '@/components/mdx/_shared/lib/gitProvider'
import type { GitRepoInfo } from '@/types/workspace'

/**
 * Renders the provider icon for a repo's clone URL. Self-hosted hosts and repos
 * with no remote get a generic git icon, since the host can't tell us which
 * provider it is.
 */
export function RepoIcon({ repoUrl, className }: { repoUrl?: string; className?: string }) {
  switch (deriveProviderFromRepoUrl(repoUrl)) {
    case 'github': return <GitHubIcon data-testid="repo-icon-github" className={className} />
    case 'gitlab': return <GitLabIcon data-testid="repo-icon-gitlab" className={className} />
    default: return <FolderGit2 data-testid="repo-icon-generic" className={className} />
  }
}

/**
 * Renders `owner/name`, or just the name when the owner is unknown (a local
 * checkout with no remote, or a URL that couldn't be parsed). With `asLink`, it
 * links to the repo's web page when one can be derived from the clone URL, and
 * falls back to plain text otherwise.
 */
export function RepoLabel({ gitInfo, className, asLink = false }: {
  gitInfo: GitRepoInfo
  className?: string
  asLink?: boolean
}) {
  const label = gitInfo.repoOwner ? `${gitInfo.repoOwner}/${gitInfo.repoName}` : gitInfo.repoName
  const href = asLink ? repoWebUrl(gitInfo.repoUrl, gitInfo.repoOwner, gitInfo.repoName) : undefined

  if (!href) return <span className={className}>{label}</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, 'hover:text-primary hover:underline')}
    >
      {label}
    </a>
  )
}
