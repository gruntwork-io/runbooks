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
import { ChevronDown, CircleDot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import type { GitWorkTree } from '@/contexts/gitWorkTreeTypes'
import { RefIcon, formatRef } from './gitRefDisplay'

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
        <CircleDot className="w-3 h-3 text-success" />
        <span className="text-xs font-medium text-muted-foreground">
          Active repository
        </span>
        <span className="text-xs text-muted-foreground">
          — scripts and templates target this repo
        </span>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 w-full text-sm border border-input rounded-lg px-2.5 py-1.5 bg-card text-foreground",
              "hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring cursor-pointer transition-colors",
            )}
          >
            <GitHubIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span className="truncate font-medium text-foreground">
              {activeWorkTree.gitInfo.repoOwner}/{activeWorkTree.gitInfo.repoName}
            </span>
            <span className="text-muted-foreground text-xs flex-shrink-0">|</span>
            <div className="flex items-center gap-1 flex-shrink-0">
              <RefIcon refType={activeWorkTree.gitInfo.refType} className="w-3 h-3 text-muted-foreground" />
              <span className="font-mono text-xs bg-muted px-1 py-0.5 rounded text-muted-foreground">
                {formatRef(activeWorkTree.gitInfo.ref, activeWorkTree.gitInfo.refType)}
              </span>
            </div>
            <ChevronDown className={cn(
              "w-3.5 h-3.5 text-muted-foreground flex-shrink-0 ml-auto transition-transform",
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
                      ? "bg-info-muted"
                      : "hover:bg-accent",
                  )}
                >
                  {/* Active indicator dot instead of checkmark */}
                  <CircleDot
                    className={cn(
                      "w-3.5 h-3.5 flex-shrink-0",
                      isActive ? "text-success" : "text-transparent",
                    )}
                  />
                  <GitHubIcon className={cn(
                    "w-3.5 h-3.5 flex-shrink-0",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )} />
                  <div className="flex flex-col min-w-0 gap-0.5">
                    <span className={cn(
                      "font-medium truncate text-sm leading-tight",
                      isActive ? "text-primary" : "text-foreground",
                    )}>
                      {wt.gitInfo.repoOwner}/{wt.gitInfo.repoName}
                    </span>
                    <div className="flex items-center gap-1">
                      <RefIcon refType={wt.gitInfo.refType} className={cn(
                        "w-3 h-3 flex-shrink-0",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )} />
                      <span className={cn(
                        "font-mono text-xs truncate",
                        isActive ? "text-primary" : "text-muted-foreground",
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
