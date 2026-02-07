/**
 * @fileoverview WorkspaceTabBar Component
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

interface WorkspaceTabBarProps {
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

export const WorkspaceTabBar = ({
  activeTab,
  onTabChange,
  tabCounts = {},
  className = "",
  availableTabs,
}: WorkspaceTabBarProps) => {
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
                ? "text-gray-900 bg-white border border-gray-300 border-b-white rounded-t-md"
                : "text-gray-500 hover:text-gray-700 rounded-t-md"
            )}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {count !== undefined && count > 0 && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 text-xs rounded-full",
                    isActive
                      ? "bg-gray-100 text-gray-700"
                      : "bg-gray-200/60 text-gray-500"
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
