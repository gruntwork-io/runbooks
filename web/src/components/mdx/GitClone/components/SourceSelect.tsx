import { Cloud, FolderGit2 } from "lucide-react"
import type { GitCloneSource } from "../types"

interface SourceSelectProps {
  source: GitCloneSource
  onSelect: (source: GitCloneSource) => void
  disabled?: boolean
}

const OPTIONS: ReadonlyArray<{ id: GitCloneSource; label: string; Icon: typeof Cloud }> = [
  { id: 'clone', label: 'Clone from remote', Icon: Cloud },
  { id: 'local', label: 'Use local checkout', Icon: FolderGit2 },
] as const

/**
 * Segmented control choosing where the repository comes from. Styled like
 * GitAuth's ProviderSelect so the git blocks read as one family. Hidden by the
 * parent when the author sets hideSourceSelect.
 */
export function SourceSelect({ source, onSelect, disabled }: SourceSelectProps) {
  return (
    <div
      className="flex gap-1 mb-2 border-b border-border"
      role="tablist"
      aria-label="Repository source"
    >
      {OPTIONS.map(({ id, label, Icon }) => {
        const active = source === id
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onSelect(id)}
            className={`px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
              active
                ? 'text-foreground border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="size-4" />
            {label}
          </button>
        )
      })}
    </div>
  )
}
