/**
 * @fileoverview WorktreeSwitcherRow Component
 *
 * A Popover-based dropdown for switching between multiple git worktrees.
 * Each option shows the GitHub icon, owner/repo, and ref name so users
 * can distinguish clones of the same repo on different refs.
 *
 * Only renders when there are 2+ worktrees.
 */

import { useState } from 'react'
import { GitBranch, Tag, GitCommit, ChevronDown, CircleDot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import type { GitWorkTree } from '@/contexts/GitWorkTreeContext'

/** Renders the appropriate icon for a git ref type. */
function RefIcon({ refType, className }: { refType?: string; className?: string }) {
  switch (refType) {
    case 'tag': return <Tag className={className} />
    case 'commit': return <GitCommit className={className} />
    default: return <GitBranch className={className} />
  }
}

/** Formats a ref for display — truncates commit SHAs. */
function formatRef(ref: string, refType?: string): string {
  if (refType === 'commit') return ref.slice(0, 7)
  return ref
}

interface WorktreeSwitcherRowProps {
  /** All registered worktrees */
  workTrees: GitWorkTree[]
  /** ID of the currently active worktree */
  activeWorkTreeId: string | null
  /** Callback when user selects a different worktree */
  onSelect: (id: string) => void
  /** Additional CSS classes */
  className?: string
}

export const WorktreeSwitcherRow = ({
  workTrees,
  activeWorkTreeId,
  onSelect,
  className,
}: WorktreeSwitcherRowProps) => {
  const [open, setOpen] = useState(false)
  const activeWorkTree = workTrees.find(wt => wt.id === activeWorkTreeId)

  if (workTrees.length < 2 || !activeWorkTree) return null

  return (
    <div className={className}>
      {/* Label: clarify this sets the target, not just the view */}
      <div className="flex items-center gap-1 mb-1">
        <CircleDot className="w-3 h-3 text-green-500" />
        <span className="text-xs font-medium text-gray-500">
          Active repository
        </span>
        <span className="text-xs text-gray-400">
          — scripts and templates target this repo
        </span>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 w-full text-sm border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white text-gray-700",
              "hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer transition-colors",
            )}
          >
            <GitHubIcon className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
            <span className="truncate font-medium text-gray-800">
              {activeWorkTree.gitInfo.repoOwner}/{activeWorkTree.gitInfo.repoName}
            </span>
            <span className="text-gray-300 text-xs flex-shrink-0">|</span>
            <div className="flex items-center gap-1 flex-shrink-0">
              <RefIcon refType={activeWorkTree.gitInfo.refType} className="w-3 h-3 text-gray-500" />
              <span className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded text-gray-600">
                {formatRef(activeWorkTree.gitInfo.ref, activeWorkTree.gitInfo.refType)}
              </span>
            </div>
            <ChevronDown className={cn(
              "w-3.5 h-3.5 text-gray-400 flex-shrink-0 ml-auto transition-transform",
              open && "rotate-180",
            )} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="p-1"
          align="start"
          side="bottom"
          style={{ width: 'var(--radix-popover-trigger-width)' }}
        >
          <div className="flex flex-col gap-0.5">
            {workTrees.map(wt => {
              const isActive = wt.id === activeWorkTreeId
              return (
                <button
                  key={wt.id}
                  onClick={() => {
                    onSelect(wt.id)
                    setOpen(false)
                  }}
                  className={cn(
                    "flex items-center gap-2 px-2 py-2 rounded-md text-sm text-left transition-colors cursor-pointer w-full",
                    isActive
                      ? "bg-blue-50"
                      : "hover:bg-gray-50",
                  )}
                >
                  {/* Active indicator dot instead of checkmark */}
                  <CircleDot
                    className={cn(
                      "w-3.5 h-3.5 flex-shrink-0",
                      isActive ? "text-green-500" : "text-transparent",
                    )}
                  />
                  <GitHubIcon className={cn(
                    "w-3.5 h-3.5 flex-shrink-0",
                    isActive ? "text-blue-500" : "text-gray-500",
                  )} />
                  <div className="flex flex-col min-w-0 gap-0.5">
                    <span className={cn(
                      "font-medium truncate text-sm leading-tight",
                      isActive ? "text-blue-800" : "text-gray-800",
                    )}>
                      {wt.gitInfo.repoOwner}/{wt.gitInfo.repoName}
                    </span>
                    <div className="flex items-center gap-1">
                      <RefIcon refType={wt.gitInfo.refType} className={cn(
                        "w-3 h-3 flex-shrink-0",
                        isActive ? "text-blue-400" : "text-gray-400",
                      )} />
                      <span className={cn(
                        "font-mono text-xs truncate",
                        isActive ? "text-blue-600" : "text-gray-500",
                      )}>
                        {formatRef(wt.gitInfo.ref, wt.gitInfo.refType)}
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
