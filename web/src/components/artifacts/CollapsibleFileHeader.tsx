import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

interface CollapsibleFileHeaderProps {
  isCollapsed: boolean
  onToggle: () => void
  /** File path shown (monospace, truncated) and copied by the copy button. */
  path: string
  /** Leading icon element (already styled by the caller). */
  icon: ReactNode
  /** Right-aligned trailing content (diff stats, line count, etc.). */
  trailing: ReactNode
}

/**
 * The clickable header bar shared by ChangedFilesView's diff rows and
 * CodeFileCollection's file rows: chevron, a caller-supplied icon, the
 * monospace path, a copy-path button, and a caller-supplied trailing slot.
 * The expensive (Prism) content stays in the caller, outside this header, so
 * the caller's React.memo boundary is preserved.
 */
export function CollapsibleFileHeader({
  isCollapsed,
  onToggle,
  path,
  icon,
  trailing,
}: CollapsibleFileHeaderProps) {
  const { didCopy, copy } = useCopyToClipboard()

  return (
    <div
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-2 bg-muted hover:bg-accent text-left cursor-pointer border-b border-border"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggle() }}
    >
      {isCollapsed ? (
        <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      ) : (
        <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      )}
      {icon}
      <span className="font-mono text-xs text-foreground truncate">
        {path}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); copy(path) }}
        className="p-0.5 text-muted-foreground hover:text-foreground rounded flex-shrink-0"
        title="Copy file path"
      >
        {didCopy ? (
          <Check className="w-3.5 h-3.5 text-success" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
      <div className="flex-1" />
      {trailing}
    </div>
  )
}
