/**
 * @fileoverview WorkspaceTabBar Component
 * 
 * Tab navigation for switching between Generated, All, and Changed views.
 */

import { cn } from '@/lib/utils'
import type { WorkspaceTab } from '@/types/workspace'

interface TabConfig {
  id: WorkspaceTab;
  label: string;
}

const TABS: TabConfig[] = [
  { id: 'all', label: 'All files' },
  { id: 'changed', label: 'Changed' },
  { id: 'generated', label: 'Generated' },
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
}

export const WorkspaceTabBar = ({
  activeTab,
  onTabChange,
  tabCounts = {},
  className = "",
}: WorkspaceTabBarProps) => {
  return (
    <div className={cn("relative flex items-end gap-2 border-b border-gray-400", className)}>
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id
        const count = tabCounts[tab.id]
        
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "relative px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer",
              "focus:outline-none",
              isActive
                ? "text-gray-900 bg-gray-50 border border-gray-400 border-b-gray-50 rounded-t-md -mb-px"
                : "text-gray-500 hover:text-gray-700"
            )}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {count !== undefined && count > 0 && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 text-xs rounded-full",
                    isActive
                      ? "bg-gray-200 text-gray-700"
                      : "bg-gray-100 text-gray-500"
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
