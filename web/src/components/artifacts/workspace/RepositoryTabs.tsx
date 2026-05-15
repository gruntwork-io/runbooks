/**
 * @fileoverview RepositoryTabs Component
 *
 * Sub-tab navigation for switching between All files and Changed files views
 * within the Repository context.
 */

import { cn } from '@/lib/utils'
import type { WorkspaceTab } from '@/types/workspace'

interface TabConfig {
  id: WorkspaceTab;
  label: string;
}

const TABS: TabConfig[] = [
  { id: 'all', label: 'All files' },
  { id: 'changed', label: 'Changed files' },
]

interface RepositoryTabsProps {
  /** Currently active tab */
  activeTab: WorkspaceTab;
  /** Callback when tab changes */
  onTabChange: (tab: WorkspaceTab) => void;
  /** Optional counts to display as badges */
  tabCounts?: Partial<Record<WorkspaceTab, number>>;
  /** Additional CSS classes */
  className?: string;
  /** Which tabs are available (defaults to all) */
  availableTabs?: WorkspaceTab[];
}

export const RepositoryTabs = ({
  activeTab,
  onTabChange,
  tabCounts = {},
  className = "",
  availableTabs,
}: RepositoryTabsProps) => {
  const visibleTabs = availableTabs 
    ? TABS.filter(tab => availableTabs.includes(tab.id))
    : TABS

  return (
    <div className={cn("relative flex items-end gap-0.5", className)}>
      {visibleTabs.map((tab) => {
        const isActive = activeTab === tab.id
        const count = tabCounts[tab.id]

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "relative px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer",
              "focus:outline-none",
              isActive
                ? "text-foreground bg-card border border-border border-b-card rounded-t-md"
                : "text-muted-foreground hover:text-foreground rounded-t-md"
            )}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {count !== undefined && count > 0 && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 text-xs rounded-full",
                    isActive
                      ? "bg-muted text-foreground"
                      : "bg-accent/60 text-muted-foreground"
                  )}
                >
                  {count}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
