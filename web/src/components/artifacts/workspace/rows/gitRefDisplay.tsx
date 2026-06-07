/**
 * Shared git-ref display helpers for the worktree rows (static + switcher).
 */

import { GitBranch, Tag, GitCommit } from 'lucide-react'

/** Renders the appropriate icon for a git ref type. */
export function RefIcon({ refType, className }: { refType?: string; className?: string }) {
  switch (refType) {
    case 'tag': return <Tag className={className} />
    case 'commit': return <GitCommit className={className} />
    default: return <GitBranch className={className} />
  }
}

/** Formats a ref for display — truncates commit SHAs. */
export function formatRef(ref: string, refType?: string): string {
  if (refType === 'commit') return ref.slice(0, 7)
  return ref
}
