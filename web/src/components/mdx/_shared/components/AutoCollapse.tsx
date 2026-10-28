import { createContext, useContext, useId, useState } from "react"
import type { Dispatch, ReactNode, SetStateAction } from "react"
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp } from "lucide-react"
import { InlineMarkdown } from "./InlineMarkdown"

/** Sets whether the block it's in is expanded. Null unless the block could fold and is expanded. */
const SetExpandedContext = createContext<Dispatch<SetStateAction<boolean>> | null>(null)

interface AutoCollapseProps {
  /** The block's `autoCollapse` prop. */
  enabled: boolean | undefined
  /** Whether the block is done: the state its progress step reports. */
  done: boolean
  /** Done with a warning, such as a Check that exits 2: the bar is yellow. */
  warn?: boolean | undefined
  /** The block's id, for the bar's test id. */
  id: string
  /** What the bar shows. A string is inline markdown. */
  title: ReactNode
  children: ReactNode
}

/**
 * Folds a done block with `autoCollapse` into a bar with its title, which
 * expands it again when clicked. It folds each time the block becomes done,
 * and a block that is done when it mounts (a resumed session) starts folded.
 * While it isn't done it never folds, so a block that is no longer done, such
 * as a sign-in that expired, shows in full.
 *
 * The block stays mounted while folded, only hidden, so its form values, logs
 * and progress step stay as they were.
 */
export function AutoCollapse({ enabled, done, warn, id, title, children }: AutoCollapseProps) {
  const collapsible = !!enabled && done
  const [expanded, setExpanded] = useState(false)
  const [wasCollapsible, setWasCollapsible] = useState(collapsible)
  if (collapsible !== wasCollapsible) {
    setWasCollapsible(collapsible)
    if (collapsible) setExpanded(false)
  }
  const collapsed = collapsible && !expanded
  const titleId = useId()
  const Icon = warn ? AlertTriangle : CheckCircle

  return (
    <SetExpandedContext.Provider value={collapsible && expanded ? setExpanded : null}>
      {collapsed && (
        <div
          data-testid={`${id}-collapsed`}
          className={`runbook-block relative rounded-sm border mb-5 flex items-center gap-3 py-2.5 pl-4 pr-3 ${
            warn ? "bg-warning-muted border-warning/30" : "bg-success-muted border-success/30"
          }`}
        >
          <Icon className={`size-5 shrink-0 ${warn ? "text-warning" : "text-success"}`} />
          <div id={titleId} className="flex-1 min-w-0 truncate text-md font-bold text-foreground">
            {typeof title === "string" ? <InlineMarkdown>{title}</InlineMarkdown> : title}
          </div>
          {/* Its ::after covers the bar, so a click anywhere on it expands the block */}
          <button
            type="button"
            aria-expanded={false}
            aria-labelledby={titleId}
            onClick={() => setExpanded(true)}
            className="shrink-0 rounded p-0.5 text-muted-foreground cursor-pointer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 after:absolute after:inset-0"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      )}
      <div hidden={collapsed} className={collapsed ? undefined : "contents"}>
        {children}
      </div>
    </SetExpandedContext.Provider>
  )
}

/**
 * Folds the block it's in back into its bar. Blocks render it beside their ID
 * label; it shows only while the block is expanded and could fold.
 */
export function CollapseButton() {
  const setExpanded = useContext(SetExpandedContext)
  if (!setExpanded) return null

  return (
    <button
      type="button"
      aria-expanded
      aria-label="Collapse block"
      onClick={() => setExpanded(false)}
      className="rounded p-0.5 text-muted-foreground cursor-pointer outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ChevronUp className="size-4" />
    </button>
  )
}
