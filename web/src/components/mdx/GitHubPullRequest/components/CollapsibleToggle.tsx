import type { ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

interface CollapsibleToggleProps {
  expanded: boolean
  onToggle: () => void
  label: string
  /** Optional icon rendered between the chevron and the label */
  icon?: ReactNode
  disabled?: boolean
  children: ReactNode
}

/** Collapsible section with a chevron toggle button */
export function CollapsibleToggle({ expanded, onToggle, label, icon, disabled, children }: CollapsibleToggleProps) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 cursor-pointer"
        disabled={disabled}
      >
        {expanded ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        {icon}
        <span className="font-medium">{label}</span>
      </button>
      {expanded && children}
    </div>
  )
}
