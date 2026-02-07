/**
 * @fileoverview WorkspaceContextBar Component
 *
 * Top-level context switcher for the files workspace.
 * Switches between "Repository" and "Generated files" contexts.
 * Uses bold underline-style tabs, visually distinct from the sub-tabs in WorkspaceTabBar.
 */

import { cn } from '@/lib/utils'
import type { WorkspaceContext } from '@/types/workspace'

interface ContextTabConfig {
  id: WorkspaceContext;
  label: string;
}

const CONTEXT_TABS: ContextTabConfig[] = [
  { id: 'repository', label: 'Repository' },
  { id: 'generated', label: 'Generated files' },
]

interface WorkspaceContextBarProps {
  /** Currently active context */
  activeContext: WorkspaceContext;
  /** Callback when context changes */
  onContextChange: (context: WorkspaceContext) => void;
  /** Optional count for generated files badge */
  generatedCount?: number;
  /** Additional CSS classes */
  className?: string;
}

export const WorkspaceContextBar = ({
  activeContext,
  onContextChange,
  generatedCount,
  className = "",
}: WorkspaceContextBarProps) => {
  return (
    <div className={cn("relative flex items-end gap-4 border-b border-gray-300", className)}>
      {CONTEXT_TABS.map((tab) => {
        const isActive = activeContext === tab.id
        const count = tab.id === 'generated' ? generatedCount : undefined

        return (
          <button
            key={tab.id}
            onClick={() => onContextChange(tab.id)}
            className={cn(
              "relative px-1 pb-2 text-sm font-semibold transition-colors cursor-pointer",
              "focus:outline-none",
              isActive
                ? "text-gray-900 border-b-2 border-gray-900 -mb-px"
                : "text-gray-400 hover:text-gray-600"
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
