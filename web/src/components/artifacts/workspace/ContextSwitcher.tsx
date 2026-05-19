/**
 * @fileoverview ContextSwitcher Component
 *
 * Top-level context switcher for the files workspace.
 * Switches between "Repository" and "Generated files" contexts.
 * Uses bold underline-style tabs, visually distinct from the sub-tabs in RepositoryTabs.
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

interface ContextSwitcherProps {
  /** Currently active context */
  activeContext: WorkspaceContext;
  /** Callback when context changes */
  onContextChange: (context: WorkspaceContext) => void;
  /** Optional count for generated files badge */
  generatedCount?: number;
  /** Additional CSS classes */
  className?: string;
}

export const ContextSwitcher = ({
  activeContext,
  onContextChange,
  generatedCount,
  className = "",
}: ContextSwitcherProps) => {
  return (
    <div className={cn("relative flex items-end gap-4 border-b border-border", className)}>
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
                ? "text-foreground border-b-2 border-foreground -mb-px"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {count !== undefined && count > 0 && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 text-xs rounded-full",
                    isActive
                      ? "bg-accent text-foreground"
                      : "bg-muted text-muted-foreground"
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
